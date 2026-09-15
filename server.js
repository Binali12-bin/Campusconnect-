require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

const STORAGE_BUCKET = "notes-pdfs";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing Supabase environment variables.");
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

/* =========================================================
   BASIC
========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "CampusConnect backend is running."
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy"
  });
});

/* =========================================================
   AUTH HELPERS
========================================================= */

async function getUserFromToken(req) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  const token = auth.replace("Bearer ", "").trim();

  if (!token) {
    return null;
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return null;
  }

  return data.user;
}

async function requireStudent(req, res, next) {
  try {
    const user = await getUserFromToken(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required."
      });
    }

    const { data: student, error } = await supabase
      .from("students")
      .select("*")
      .eq("auth_user_id", user.id)
      .single();

    if (error || !student) {
      return res.status(403).json({
        success: false,
        message: "Student account not found."
      });
    }

    if (!student.is_active) {
      return res.status(403).json({
        success: false,
        message: "Your student account is inactive."
      });
    }

    req.user = user;
    req.student = student;

    next();
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Authentication error."
    });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await getUserFromToken(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Admin authentication required."
      });
    }

    const { data: admin, error } = await supabase
      .from("admins")
      .select("*")
      .eq("auth_user_id", user.id)
      .eq("is_active", true)
      .single();

    if (error || !admin) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized as an administrator."
      });
    }

    req.user = user;
    req.admin = admin;

    next();
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Admin authentication error."
    });
  }
}

/* =========================================================
   STUDENT
========================================================= */

app.get("/api/student/me", requireStudent, async (req, res) => {
  res.json({
    success: true,
    student: req.student
  });
});

/* =========================================================
   COURSES - STUDENT
========================================================= */

app.get("/api/courses", requireStudent, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("courses")
      .select("*")
      .order("course_code", { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      courses: data || []
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to load courses."
    });
  }
});

/* =========================================================
   NOTES - STUDENT
========================================================= */

app.get("/api/notes", requireStudent, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();

    let query = supabase
      .from("notes")
      .select(`
        id,
        title,
        description,
        price_kobo,
        course_id,
        is_active,
        created_at,
        courses (
          id,
          course_code,
          course_title
        )
      `)
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    const { data, error } = await query;

    if (error) throw error;

    let notes = data || [];

    if (search) {
      const term = search.toLowerCase();

      notes = notes.filter((note) => {
        const title = String(note.title || "").toLowerCase();
        const description = String(note.description || "").toLowerCase();
        const courseCode = String(
          note.courses?.course_code || ""
        ).toLowerCase();
        const courseTitle = String(
          note.courses?.course_title || ""
        ).toLowerCase();

        return (
          title.includes(term) ||
          description.includes(term) ||
          courseCode.includes(term) ||
          courseTitle.includes(term)
        );
      });
    }

    res.json({
      success: true,
      notes
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to load notes."
    });
  }
});

/* =========================================================
   WALLET
========================================================= */

app.get("/api/wallet", requireStudent, async (req, res) => {
  res.json({
    success: true,
    wallet_balance_kobo: req.student.wallet_balance_kobo || 0,
    wallet_balance_naira:
      Number(req.student.wallet_balance_kobo || 0) / 100
  });
});

/* =========================================================
   PAYSTACK INITIALIZE
========================================================= */

app.post("/api/paystack/initialize", requireStudent, async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        message: "Paystack is not configured."
      });
    }

    const amountNaira = Number(req.body.amount_naira);

    if (!Number.isFinite(amountNaira) || amountNaira <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment amount."
      });
    }

    const amountKobo = Math.round(amountNaira * 100);

    const reference =
      "CC-" +
      Date.now() +
      "-" +
      crypto.randomBytes(5).toString("hex");

    const { error: paymentError } = await supabase
      .from("payments")
      .insert({
        student_id: req.student.id,
        reference,
        amount_kobo: amountKobo,
        status: "pending",
        provider: "paystack"
      });

    if (paymentError) throw paymentError;

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: req.user.email,
          amount: amountKobo,
          reference,
          metadata: {
            student_id: req.student.id
          }
        })
      }
    );

    const result = await response.json();

    if (!response.ok || !result.status) {
      return res.status(400).json({
        success: false,
        message: result.message || "Paystack initialization failed."
      });
    }

    res.json({
      success: true,
      reference,
      authorization_url: result.data.authorization_url,
      access_code: result.data.access_code
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to initialize payment."
    });
  }
});

/* =========================================================
   PAYSTACK VERIFY
========================================================= */

app.post("/api/paystack/verify", requireStudent, async (req, res) => {
  try {
    const reference = String(req.body.reference || "").trim();

    if (!reference) {
      return res.status(400).json({
        success: false,
        message: "Payment reference is required."
      });
    }

    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const result = await response.json();

    if (!response.ok || !result.status) {
      return res.status(400).json({
        success: false,
        message: "Unable to verify payment."
      });
    }

    const transaction = result.data;

    if (transaction.status !== "success") {
      return res.status(400).json({
        success: false,
        message: "Payment was not successful."
      });
    }

    const { data: payment, error: paymentError } = await supabase
      .from("payments")
      .select("*")
      .eq("reference", reference)
      .eq("student_id", req.student.id)
      .single();

    if (paymentError || !payment) {
      return res.status(404).json({
        success: false,
        message: "Payment record not found."
      });
    }

    if (Number(transaction.amount) !== Number(payment.amount_kobo)) {
      return res.status(400).json({
        success: false,
        message: "Payment amount mismatch."
      });
    }

    if (payment.status === "success") {
      return res.json({
        success: true,
        message: "Payment was already processed.",
        amount_kobo: payment.amount_kobo
      });
    }

    const { error: updateError } = await supabase
      .from("payments")
      .update({
        status: "success",
        paid_at: new Date().toISOString()
      })
      .eq("id", payment.id);

    if (updateError) throw updateError;

    const newBalance =
      Number(req.student.wallet_balance_kobo || 0) +
      Number(payment.amount_kobo);

    const { error: balanceError } = await supabase
      .from("students")
      .update({
        wallet_balance_kobo: newBalance
      })
      .eq("id", req.student.id);

    if (balanceError) throw balanceError;

    await supabase
      .from("wallet_transactions")
      .insert({
        student_id: req.student.id,
        type: "credit",
        amount_kobo: payment.amount_kobo,
        reference,
        description: "Paystack wallet funding"
      });

    res.json({
      success: true,
      message: "Wallet funded successfully.",
      amount_kobo: payment.amount_kobo,
      wallet_balance_kobo: newBalance
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Payment verification failed."
    });
  }
});

/* =========================================================
   PAYSTACK WEBHOOK
========================================================= */

app.post(
  "/api/paystack/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-paystack-signature"];

      if (!signature || !PAYSTACK_SECRET_KEY) {
        return res.status(401).send("Unauthorized");
      }

      const hash = crypto
        .createHmac("sha512", PAYSTACK_SECRET_KEY)
        .update(req.body)
        .digest("hex");

      if (hash !== signature) {
        return res.status(401).send("Invalid signature");
      }

      const event = JSON.parse(req.body.toString());

      if (event.event !== "charge.success") {
        return res.sendStatus(200);
      }

      const transaction = event.data;
      const reference = transaction.reference;

      const { data: payment } = await supabase
        .from("payments")
        .select("*")
        .eq("reference", reference)
        .single();

      if (!payment || payment.status === "success") {
        return res.sendStatus(200);
      }

      if (Number(transaction.amount) !== Number(payment.amount_kobo)) {
        return res.sendStatus(200);
      }

      await supabase
        .from("payments")
        .update({
          status: "success",
          paid_at: new Date().toISOString()
        })
        .eq("id", payment.id);

      const { data: student } = await supabase
        .from("students")
        .select("wallet_balance_kobo")
        .eq("id", payment.student_id)
        .single();

      if (student) {
        const newBalance =
          Number(student.wallet_balance_kobo || 0) +
          Number(payment.amount_kobo);

        await supabase
          .from("students")
          .update({
            wallet_balance_kobo: newBalance
          })
          .eq("id", payment.student_id);

        await supabase
          .from("wallet_transactions")
          .insert({
            student_id: payment.student_id,
            type: "credit",
            amount_kobo: payment.amount_kobo,
            reference,
            description: "Paystack webhook wallet funding"
          });
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error(error);
      return res.sendStatus(200);
    }
  }
);

/* =========================================================
   PURCHASE NOTE
========================================================= */

app.post("/api/purchases/buy", requireStudent, async (req, res) => {
  try {
    const noteId = String(req.body.note_id || "").trim();

    if (!noteId) {
      return res.status(400).json({
        success: false,
        message: "Note ID is required."
      });
    }

    const { data: note, error: noteError } = await supabase
      .from("notes")
      .select("*")
      .eq("id", noteId)
      .eq("is_active", true)
      .single();

    if (noteError || !note) {
      return res.status(404).json({
        success: false,
        message: "Note not found."
      });
    }

    const { data: existing } = await supabase
      .from("purchases")
      .select("*")
      .eq("student_id", req.student.id)
      .eq("note_id", note.id)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({
        success: false,
        message: "You already purchased this note."
      });
    }

    const balance = Number(req.student.wallet_balance_kobo || 0);
    const price = Number(note.price_kobo || 0);

    if (balance < price) {
      return res.status(400).json({
        success: false,
        message: "Insufficient wallet balance."
      });
    }

    const newBalance = balance - price;

    const { error: balanceError } = await supabase
      .from("students")
      .update({
        wallet_balance_kobo: newBalance
      })
      .eq("id", req.student.id);

    if (balanceError) throw balanceError;

    const { data: purchase, error: purchaseError } =
      await supabase
        .from("purchases")
        .insert({
          student_id: req.student.id,
          note_id: note.id,
          amount_kobo: price
        })
        .select()
        .single();

    if (purchaseError) {
      await supabase
        .from("students")
        .update({
          wallet_balance_kobo: balance
        })
        .eq("id", req.student.id);

      throw purchaseError;
    }

    await supabase
      .from("wallet_transactions")
      .insert({
        student_id: req.student.id,
        type: "debit",
        amount_kobo: price,
        reference: purchase.id,
        description: `Purchase of note: ${note.title}`
      });

    res.json({
      success: true,
      message: "Note purchased successfully.",
      purchase,
      wallet_balance_kobo: newBalance
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to purchase note."
    });
  }
});

/* =========================================================
   STUDENT LIBRARY
========================================================= */

app.get("/api/library", requireStudent, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("purchases")
      .select(`
        id,
        amount_kobo,
        created_at,
        notes (
          id,
          title,
          description,
          price_kobo,
          course_id,
          courses (
            course_code,
            course_title
          )
        )
      `)
      .eq("student_id", req.student.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      library: data || []
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to load library."
    });
  }
});

/* =========================================================
   SECURE PDF DOWNLOAD
========================================================= */

app.get(
  "/api/library/:purchaseId/download",
  requireStudent,
  async (req, res) => {
    try {
      const purchaseId = req.params.purchaseId;

      const { data: purchase, error } = await supabase
        .from("purchases")
        .select(`
          id,
          student_id,
          notes (
            id,
            title,
            file_url
          )
        `)
        .eq("id", purchaseId)
        .eq("student_id", req.student.id)
        .single();

      if (error || !purchase || !purchase.notes) {
        return res.status(404).json({
          success: false,
          message: "Purchased note not found."
        });
      }

      const filePath = purchase.notes.file_url;

      if (!filePath) {
        return res.status(404).json({
          success: false,
          message: "PDF file is not available."
        });
      }

      const { data, error: signedError } = await supabase
        .storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(filePath, 300);

      if (signedError) throw signedError;

      res.json({
        success: true,
        download_url: data.signedUrl
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Unable to create download link."
      });
    }
  }
);

/* =========================================================
   ADMIN PROFILE
========================================================= */

app.get("/api/admin/me", requireAdmin, async (req, res) => {
  res.json({
    success: true,
    admin: req.admin
  });
});

/* =========================================================
   ADMIN DASHBOARD
========================================================= */

app.get("/api/admin/dashboard", requireAdmin, async (req, res) => {
  try {
    const [
      students,
      courses,
      notes,
      payments,
      purchases
    ] = await Promise.all([
      supabase.from("students").select("id", { count: "exact", head: true }),
      supabase.from("courses").select("id", { count: "exact", head: true }),
      supabase.from("notes").select("id", { count: "exact", head: true }),
      supabase.from("payments").select("id", { count: "exact", head: true }),
      supabase.from("purchases").select("id", { count: "exact", head: true })
    ]);

    res.json({
      success: true,
      stats: {
        students: students.count || 0,
        courses: courses.count || 0,
        notes: notes.count || 0,
        payments: payments.count || 0,
        purchases: purchases.count || 0
      }
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to load dashboard."
    });
  }
});

/* =========================================================
   ADMIN COURSES
========================================================= */

app.get("/api/admin/courses", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("courses")
      .select("*")
      .order("course_code", { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      courses: data || []
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to load courses."
    });
  }
});

app.post("/api/admin/courses", requireAdmin, async (req, res) => {
  try {
    const courseCode = String(req.body.course_code || "").trim();
    const courseTitle = String(req.body.course_title || "").trim();
    const description = String(req.body.description || "").trim();

    if (!courseCode || !courseTitle) {
      return res.status(400).json({
        success: false,
        message: "Course code and course title are required."
      });
    }

    const { data, error } = await supabase
      .from("courses")
      .insert({
        course_code: courseCode,
        course_title: courseTitle,
        description
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      course: data
    });
  } catch (error) {
    console.error(error);

    res.status(400).json({
      success: false,
      message: error.message || "Unable to create course."
    });
  }
});

app.patch("/api/admin/courses/:id", requireAdmin, async (req, res) => {
  try {
    const updates = {};

    if (req.body.course_code !== undefined) {
      updates.course_code = String(req.body.course_code).trim();
    }

    if (req.body.course_title !== undefined) {
      updates.course_title = String(req.body.course_title).trim();
    }

    if (req.body.description !== undefined) {
      updates.description = String(req.body.description).trim();
    }

    const { data, error } = await supabase
      .from("courses")
      .update(updates)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      course: data
    });
  } catch (error) {
    console.error(error);

    res.status(400).json({
      success: false,
      message: error.message || "Unable to update course."
    });
  }
});

app.delete("/api/admin/courses/:id", requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from("courses")
      .delete()
      .eq("id", req.params.id);

    if (error) throw error;

    res.json({
      success: true,
      message: "Course deleted."
    });
  } catch (error) {
    console.error(error);

    res.status(400).json({
      success: false,
      message:
        "Unable to delete course. Remove or move its notes first if they exist."
    });
  }
});

/* =========================================================
   ADMIN NOTES
========================================================= */

app.get("/api/admin/notes", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("notes")
      .select(`
        *,
        courses (
          course_code,
          course_title
        )
      `)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      notes: data || []
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to load notes."
    });
  }
});

/*
  Creates a note record.
  file_url should contain the Supabase Storage path,
  for example:

  notes/course-id/note-id.pdf
*/

app.post("/api/admin/notes", requireAdmin, async (req, res) => {
  try {
    const courseId = String(req.body.course_id || "").trim();
    const title = String(req.body.title || "").trim();
    const description = String(req.body.description || "").trim();
    const priceNaira = Number(req.body.price_naira);
    const filePath = String(req.body.file_path || "").trim();

    if (!courseId || !title || !Number.isFinite(priceNaira)) {
      return res.status(400).json({
        success: false,
        message: "Course, title and price are required."
      });
    }

    if (priceNaira < 0) {
      return res.status(400).json({
        success: false,
        message: "Price cannot be negative."
      });
    }

    const priceKobo = Math.round(priceNaira * 100);

    const { data, error } = await supabase
      .from("notes")
      .insert({
        course_id: courseId,
        title,
        description,
        price_kobo: priceKobo,
        file_url: filePath || null,
        is_active: true
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      note: data
    });
  } catch (error) {
    console.error(error);

    res.status(400).json({
      success: false,
      message: error.message || "Unable to create note."
    });
  }
});

app.patch("/api/admin/notes/:id", requireAdmin, async (req, res) => {
  try {
    const updates = {};

    if (req.body.course_id !== undefined) {
      updates.course_id = req.body.course_id;
    }

    if (req.body.title !== undefined) {
      updates.title = String(req.body.title).trim();
    }

    if (req.body.description !== undefined) {
      updates.description = String(req.body.description).trim();
    }

    if (req.body.price_naira !== undefined) {
      const price = Number(req.body.price_naira);

      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid price."
        });
      }

      updates.price_kobo = Math.round(price * 100);
    }

    if (req.body.file_path !== undefined) {
      updates.file_url = String(req.body.file_path).trim();
    }

    if (req.body.is_active !== undefined) {
      updates.is_active = Boolean(req.body.is_active);
    }

    const { data, error } = await supabase
      .from("notes")
      .update(updates)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      note: data
    });
  } catch (error) {
    console.error(error);

    res.status(400).json({
      success: false,
      message: error.message || "Unable to update note."
    });
  }
});

app.delete("/api/admin/notes/:id", requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from("notes")
      .delete()
      .eq("id", req.params.id);

    if (error) throw error;

    res.json({
      success: true,
      message: "Note deleted."
    });
  } catch (error) {
    console.error(error);

    res.status(400).json({
      success: false,
      message:
        "Unable to delete note. A note with existing purchases may need to be deactivated instead."
    });
  }
});

/* =========================================================
   ADMIN PDF UPLOAD URL
========================================================= */

app.post(
  "/api/admin/notes/upload-url",
  requireAdmin,
  async (req, res) => {
    try {
      const fileName = String(req.body.file_name || "").trim();

      if (!fileName) {
        return res.status(400).json({
          success: false,
          message: "File name is required."
        });
      }

      const safeName = fileName
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 150);

      const filePath =
        `uploads/${Date.now()}-${crypto.randomBytes(5).toString("hex")}-${safeName}`;

      const { data, error } = await supabase
        .storage
        .from(STORAGE_BUCKET)
        .createSignedUploadUrl(filePath);

      if (error) throw error;

      res.json({
        success: true,
        path: filePath,
        token: data.token
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Unable to create upload URL."
      });
    }
  }
);

/* =========================================================
   ADMIN STUDENTS
========================================================= */

app.get("/api/admin/students", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("students")
      .select(`
        id,
        full_name,
        email,
        phone,
        is_active,
        wallet_balance_kobo,
        created_at
      `)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      students: data || []
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to load students."
    });
  }
});

app.patch(
  "/api/admin/students/:id/status",
  requireAdmin,
  async (req, res) => {
    try {
      const isActive = Boolean(req.body.is_active);

      const { data, error } = await supabase
        .from("students")
        .update({
          is_active: isActive
        })
        .eq("id", req.params.id)
        .select()
        .single();

      if (error) throw error;

      res.json({
        success: true,
        student: data
      });
    } catch (error) {
      console.error(error);

      res.status(400).json({
        success: false,
        message: "Unable to update student status."
      });
    }
  }
);

/* =========================================================
   ADMIN PAYMENTS
========================================================= */

app.get("/api/admin/payments", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("payments")
      .select(`
        *,
        students (
          full_name,
          email
        )
      `)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      payments: data || []
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to load payments."
    });
  }
});

/* =========================================================
   ADMIN PURCHASES
========================================================= */

app.get("/api/admin/purchases", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("purchases")
      .select(`
        *,
        students (
          full_name,
          email
        ),
        notes (
          title,
          price_kobo,
          courses (
            course_code,
            course_title
          )
        )
      `)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      purchases: data || []
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to load purchases."
    });
  }
});

/* =========================================================
   ADMIN WALLET TRANSACTIONS
========================================================= */

app.get(
  "/api/admin/wallet-transactions",
  requireAdmin,
  async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("wallet_transactions")
        .select(`
          *,
          students (
            full_name,
            email
          )
        `)
        .order("created_at", { ascending: false });

      if (error) throw error;

      res.json({
        success: true,
        transactions: data || []
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Unable to load wallet transactions."
      });
    }
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    success: false,
    message: "Internal server error."
  });
});

/* =========================================================
   START
========================================================= */

app.listen(PORT, () => {
  console.log(
    `CampusConnect backend running on port ${PORT}`
  );
});
