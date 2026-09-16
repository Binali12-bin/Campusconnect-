require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 10000;

// ======================================================
// CONFIGURATION
// ======================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const JWT_SECRET =
  process.env.JWT_SECRET || "change-this-secret";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
  );
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

// ======================================================
// MIDDLEWARE
// ======================================================

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("combined"));

// ======================================================
// BASIC ROUTES
// ======================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "CampusConnect API is running 🚀"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    service: "CampusConnect Backend"
  });
});

// ======================================================
// AUTH HELPERS
// ======================================================

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      auth_user_id: user.auth_user_id,
      role: user.role,
      email: user.email
    },
    JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );
}

function getToken(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  return header.substring(7);
}

function requireAuth(req, res, next) {
  try {
    const token = getToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    req.user = jwt.verify(token, JWT_SECRET);

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token"
    });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Admin access required"
    });
  }

  next();
}

function requireStudent(req, res, next) {
  if (!req.user || req.user.role !== "student") {
    return res.status(403).json({
      success: false,
      message: "Student access required"
    });
  }

  next();
}

// ======================================================
// AUTHENTICATION
// ======================================================

// ------------------------------------------------------
// STUDENT REGISTER
// ------------------------------------------------------

app.post("/api/auth/register", async (req, res) => {
  try {
    const {
      email,
      password,
      full_name,
      phone
    } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({
        success: false,
        message:
          "Email, password and full name are required"
      });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = full_name.trim();
    const cleanPhone = phone ? phone.trim() : "";

    // Check whether email belongs to an administrator
    const {
      data: existingAdmin,
      error: adminCheckError
    } = await supabase
      .from("admins")
      .select("id")
      .ilike("email", cleanEmail)
      .maybeSingle();

    if (adminCheckError) {
      console.error(
        "ADMIN CHECK ERROR:",
        adminCheckError
      );

      return res.status(500).json({
        success: false,
        message: "Unable to verify account type"
      });
    }

    if (existingAdmin) {
      return res.status(403).json({
        success: false,
        message:
          "This email is reserved for an administrator"
      });
    }

    // Create Supabase Auth account
    const {
      data: authData,
      error: authError
    } = await supabase.auth.admin.createUser({
      email: cleanEmail,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: cleanName,
        phone: cleanPhone
      }
    });

    if (authError) {
      console.error(
        "SUPABASE AUTH ERROR:",
        authError
      );

      return res.status(400).json({
        success: false,
        message: authError.message
      });
    }

    if (!authData || !authData.user) {
      return res.status(500).json({
        success: false,
        message: "Authentication account was not created"
      });
    }

    // The database trigger should create the student profile.
    // We wait briefly and then retrieve it.
    let student = null;
    let studentError = null;

    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await supabase
        .from("students")
        .select("*")
        .eq("auth_user_id", authData.user.id)
        .maybeSingle();

      student = result.data;
      studentError = result.error;

      if (student) {
        break;
      }

      await new Promise(resolve =>
        setTimeout(resolve, 500)
      );
    }

    if (studentError) {
      console.error(
        "STUDENT PROFILE ERROR:",
        studentError
      );

      return res.status(500).json({
        success: false,
        message: studentError.message
      });
    }

    // If trigger didn't create the profile, create it here.
    if (!student) {
      const {
        data: createdStudent,
        error: createStudentError
      } = await supabase
        .from("students")
        .insert({
          auth_user_id: authData.user.id,
          full_name: cleanName,
          email: cleanEmail,
          phone: cleanPhone,
          wallet_balance_kobo: 0,
          is_active: true
        })
        .select()
        .single();

      if (createStudentError) {
        console.error(
          "CREATE STUDENT ERROR:",
          createStudentError
        );

        return res.status(500).json({
          success: false,
          message: createStudentError.message
        });
      }

      student = createdStudent;
    }

    const token = createToken({
      id: student.id,
      auth_user_id: student.auth_user_id,
      email: student.email,
      role: "student"
    });

    return res.status(201).json({
      success: true,
      message: "Student account created successfully",
      token,
      user: {
        id: student.id,
        full_name: student.full_name,
        email: student.email,
        phone: student.phone,
        role: "student",
        wallet_balance_kobo:
          student.wallet_balance_kobo
      }
    });

  } catch (error) {
    console.error(
      "REGISTRATION ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Registration failed"
    });
  }
});

// ------------------------------------------------------
// LOGIN
// ------------------------------------------------------

app.post("/api/auth/login", async (req, res) => {
  try {
    const {
      email,
      password
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message:
          "Email and password are required"
      });
    }

    const cleanEmail =
      email.trim().toLowerCase();

    // ==================================================
    // ADMIN LOGIN
    // ==================================================

    const {
      data: admin,
      error: adminError
    } = await supabase
      .from("admins")
      .select("*")
      .ilike("email", cleanEmail)
      .maybeSingle();

    if (adminError) {
      console.error(
        "ADMIN LOGIN CHECK ERROR:",
        adminError
      );
    }

    if (admin) {
      const {
        data: authData,
        error: authError
      } = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password
      });

      if (authError) {
        return res.status(401).json({
          success: false,
          message: "Invalid email or password"
        });
      }

      if (
        !authData.user ||
        authData.user.id !== admin.auth_user_id
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Administrator account is not correctly linked"
        });
      }

      if (!admin.is_active) {
        return res.status(403).json({
          success: false,
          message:
            "Admin account is inactive"
        });
      }

      const token = createToken({
        id: admin.id,
        auth_user_id: admin.auth_user_id,
        email: admin.email,
        role: "admin"
      });

      return res.json({
        success: true,
        message: "Admin login successful",
        token,
        user: {
          id: admin.id,
          full_name: admin.full_name,
          email: admin.email,
          role: "admin"
        }
      });
    }

    // ==================================================
    // STUDENT LOGIN
    // ==================================================

    const {
      data: authData,
      error: authError
    } = await supabase.auth.signInWithPassword({
      email: cleanEmail,
      password
    });

    if (authError) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    const {
      data: student,
      error: studentError
    } = await supabase
      .from("students")
      .select("*")
      .eq("auth_user_id", authData.user.id)
      .maybeSingle();

    if (studentError) {
      console.error(
        "STUDENT LOGIN ERROR:",
        studentError
      );

      return res.status(500).json({
        success: false,
        message: studentError.message
      });
    }

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student profile not found"
      });
    }

    if (!student.is_active) {
      return res.status(403).json({
        success: false,
        message:
          "Student account is inactive"
      });
    }

    const token = createToken({
      id: student.id,
      auth_user_id: student.auth_user_id,
      email: student.email,
      role: "student"
    });

    return res.json({
      success: true,
      message: "Student login successful",
      token,
      user: {
        id: student.id,
        full_name: student.full_name,
        email: student.email,
        phone: student.phone,
        role: "student",
        wallet_balance_kobo:
          student.wallet_balance_kobo
      }
    });

  } catch (error) {
    console.error(
      "LOGIN ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Login failed"
    });
  }
});

// ======================================================
// CURRENT USER
// ======================================================

app.get(
  "/api/auth/me",
  requireAuth,
  async (req, res) => {
    try {
      if (req.user.role === "admin") {
        const {
          data,
          error
        } = await supabase
          .from("admins")
          .select("*")
          .eq("id", req.user.id)
          .single();

        if (error) {
          return res.status(404).json({
            success: false,
            message: "Admin not found"
          });
        }

        return res.json({
          success: true,
          user: {
            ...data,
            role: "admin"
          }
        });
      }

      const {
        data,
        error
      } = await supabase
        .from("students")
        .select("*")
        .eq("id", req.user.id)
        .single();

      if (error) {
        return res.status(404).json({
          success: false,
          message: "Student not found"
        });
      }

      return res.json({
        success: true,
        user: {
          ...data,
          role: "student"
        }
      });

    } catch (error) {
      return res.status(500).json({
        success: false,
        message:
          "Unable to load account"
      });
    }
  }
);

// ======================================================
// COURSES
// ======================================================

// STUDENTS / AUTHENTICATED USERS
app.get(
  "/api/courses",
  requireAuth,
  async (req, res) => {
    try {
      const {
        data,
        error
      } = await supabase
        .from("courses")
        .select("*")
        .order("course_code", {
          ascending: true
        });

      if (error) throw error;

      return res.json({
        success: true,
        courses: data || []
      });

    } catch (error) {
      console.error(
        "LOAD COURSES ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to load courses"
      });
    }
  }
);

// ADMIN CREATE COURSE
app.post(
  "/api/admin/courses",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        course_code,
        course_title,
        description
      } = req.body;

      if (!course_code || !course_title) {
        return res.status(400).json({
          success: false,
          message:
            "Course code and title are required"
        });
      }

      const {
        data,
        error
      } = await supabase
        .from("courses")
        .insert({
          course_code:
            course_code.toUpperCase().trim(),
          course_title:
            course_title.trim(),
          description:
            description || ""
        })
        .select()
        .single();

      if (error) throw error;

      return res.status(201).json({
        success: true,
        course: data
      });

    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }
);

// ADMIN UPDATE COURSE
app.put(
  "/api/admin/courses/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        course_code,
        course_title,
        description
      } = req.body;

      const updateData = {};

      if (course_code !== undefined) {
        updateData.course_code =
          course_code.toUpperCase().trim();
      }

      if (course_title !== undefined) {
        updateData.course_title =
          course_title.trim();
      }

      if (description !== undefined) {
        updateData.description =
          description;
      }

      const {
        data,
        error
      } = await supabase
        .from("courses")
        .update(updateData)
        .eq("id", req.params.id)
        .select()
        .single();

      if (error) throw error;

      return res.json({
        success: true,
        course: data
      });

    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }
);

// ADMIN DELETE COURSE
app.delete(
  "/api/admin/courses/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        error
      } = await supabase
        .from("courses")
        .delete()
        .eq("id", req.params.id);

      if (error) throw error;

      return res.json({
        success: true,
        message: "Course deleted"
      });

    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }
);

// ======================================================
// NOTES
// ======================================================

// GET ACTIVE NOTES
app.get(
  "/api/notes",
  requireAuth,
  async (req, res) => {
    try {
      const {
        data,
        error
      } = await supabase
        .from("notes")
        .select(`
          id,
          title,
          description,
          price_kobo,
          course_id,
          created_at,
          courses (
            course_code,
            course_title
          )
        `)
        .eq("is_active", true)
        .order("created_at", {
          ascending: false
        });

      if (error) throw error;

      return res.json({
        success: true,
        notes: data || []
      });

    } catch (error) {
      console.error(
        "LOAD NOTES ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to load notes"
      });
    }
  }
);

// ADMIN CREATE NOTE
app.post(
  "/api/admin/notes",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        course_id,
        title,
        description,
        price_kobo,
        file_url
      } = req.body;

      if (
        !course_id ||
        !title ||
        price_kobo === undefined ||
        !file_url
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Course, title, price and file are required"
        });
      }

      const {
        data,
        error
      } = await supabase
        .from("notes")
        .insert({
          course_id,
          title: title.trim(),
          description:
            description || "",
          price_kobo:
            Number(price_kobo),
          file_url,
          uploader_id:
            req.user.id,
          is_active: true
        })
        .select()
        .single();

      if (error) throw error;

      return res.status(201).json({
        success: true,
        note: data
      });

    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }
);

// ADMIN UPDATE NOTE
app.put(
  "/api/admin/notes/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        course_id,
        title,
        description,
        price_kobo,
        file_url,
        is_active
      } = req.body;

      const updateData = {};

      if (course_id !== undefined) {
        updateData.course_id =
          course_id;
      }

      if (title !== undefined) {
        updateData.title =
          title.trim();
      }

      if (description !== undefined) {
        updateData.description =
          description;
      }

      if (price_kobo !== undefined) {
        updateData.price_kobo =
          Number(price_kobo);
      }

      if (file_url !== undefined) {
        updateData.file_url =
          file_url;
      }

      if (is_active !== undefined) {
        updateData.is_active =
          is_active;
      }

      const {
        data,
        error
      } = await supabase
        .from("notes")
        .update(updateData)
        .eq("id", req.params.id)
        .select()
        .single();

      if (error) throw error;

      return res.json({
        success: true,
        note: data
      });

    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }
);

// ADMIN DELETE NOTE
app.delete(
  "/api/admin/notes/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        error
      } = await supabase
        .from("notes")
        .delete()
        .eq("id", req.params.id);

      if (error) throw error;

      return res.json({
        success: true,
        message: "Note deleted"
      });

    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }
);

// ======================================================
// STUDENT PROFILE
// ======================================================

app.put(
  "/api/student/profile",
  requireAuth,
  requireStudent,
  async (req, res) => {
    try {
      const {
        full_name,
        phone
      } = req.body;

      const {
        data,
        error
      } = await supabase
        .from("students")
        .update({
          full_name,
          phone
        })
        .eq("id", req.user.id)
        .select()
        .single();

      if (error) throw error;

      return res.json({
        success: true,
        user: data
      });

    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }
);

// ======================================================
// WALLET
// ======================================================

app.get(
  "/api/student/wallet",
  requireAuth,
  requireStudent,
  async (req, res) => {
    try {
      const {
        data: student,
        error: studentError
      } = await supabase
        .from("students")
        .select("wallet_balance_kobo")
        .eq("id", req.user.id)
        .single();

      if (studentError) {
        throw studentError;
      }

      const {
        data: transactions,
        error: transactionError
      } = await supabase
        .from("wallet_transactions")
        .select("*")
        .eq("student_id", req.user.id)
        .order("created_at", {
          ascending: false
        });

      if (transactionError) {
        throw transactionError;
      }

      return res.json({
        success: true,
        wallet_balance_kobo:
          student.wallet_balance_kobo,
        transactions:
          transactions || []
      });

    } catch (error) {
      console.error(
        "WALLET ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to load wallet"
      });
    }
  }
);

// ======================================================
// PURCHASE
// ======================================================

app.post(
  "/api/purchases",
  requireAuth,
  requireStudent,
  async (req, res) => {
    try {
      const {
        note_id
      } = req.body;

      if (!note_id) {
        return res.status(400).json({
          success: false,
          message:
            "note_id is required"
        });
      }

      // Get student
      const {
        data: student,
        error: studentError
      } = await supabase
        .from("students")
        .select("*")
        .eq("id", req.user.id)
        .single();

      if (studentError || !student) {
        return res.status(404).json({
          success: false,
          message:
            "Student not found"
        });
      }

      // Get note
      const {
        data: note,
        error: noteError
      } = await supabase
        .from("notes")
        .select("*")
        .eq("id", note_id)
        .eq("is_active", true)
        .single();

      if (noteError || !note) {
        return res.status(404).json({
          success: false,
          message:
            "Note not found"
        });
      }

      // Check existing purchase
      const {
        data: existingPurchase
      } = await supabase
        .from("purchases")
        .select("id")
        .eq("student_id", student.id)
        .eq("note_id", note.id)
        .maybeSingle();

      if (existingPurchase) {
        return res.status(409).json({
          success: false,
          message:
            "You already purchased this note"
        });
      }

      const amount =
        Number(note.price_kobo);

      if (
        Number(student.wallet_balance_kobo) <
        amount
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Insufficient wallet balance"
        });
      }

      const newBalance =
        Number(student.wallet_balance_kobo) -
        amount;

      // Update balance
      const {
        error: balanceError
      } = await supabase
        .from("students")
        .update({
          wallet_balance_kobo:
            newBalance
        })
        .eq("id", student.id)
        .eq(
          "wallet_balance_kobo",
          student.wallet_balance_kobo
        );

      if (balanceError) {
        throw balanceError;
      }

      // Create purchase
      const {
        data: purchase,
        error: purchaseError
      } = await supabase
        .from("purchases")
        .insert({
          student_id:
            student.id,
          note_id:
            note.id,
          amount_kobo:
            amount
        })
        .select()
        .single();

      if (purchaseError) {
        // Restore balance
        await supabase
          .from("students")
          .update({
            wallet_balance_kobo:
              student.wallet_balance_kobo
          })
          .eq("id", student.id)
          .eq(
            "wallet_balance_kobo",
            newBalance
          );

        throw purchaseError;
      }

      // Wallet transaction
      const reference =
        `purchase_${student.id}_${note.id}_${Date.now()}`;

      await supabase
        .from("wallet_transactions")
        .insert({
          student_id:
            student.id,
          type:
            "purchase",
          amount_kobo:
            -amount,
          reference,
          description:
            `Purchase of ${note.title}`
        });

      return res.status(201).json({
        success: true,
        message:
          "Note purchased successfully",
        purchase,
        wallet_balance_kobo:
          newBalance
      });

    } catch (error) {
      console.error(
        "PURCHASE ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Purchase failed"
      });
    }
  }
);

// ======================================================
// MY LIBRARY
// ======================================================

app.get(
  "/api/library",
  requireAuth,
  requireStudent,
  async (req, res) => {
    try {
      const {
        data,
        error
      } = await supabase
        .from("purchases")
        .select(`
          id,
          amount_kobo,
          created_at,
          notes (
            id,
            title,
            description,
            file_url,
            courses (
              course_code,
              course_title
            )
          )
        `)
        .eq(
          "student_id",
          req.user.id
        )
        .order("created_at", {
          ascending: false
        });

      if (error) throw error;

      return res.json({
        success: true,
        library: data || []
      });

    } catch (error) {
      console.error(
        "LIBRARY ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to load library"
      });
    }
  }
);

// ======================================================
// ADMIN DASHBOARD
// ======================================================

app.get(
  "/api/admin/dashboard",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const [
        studentsResult,
        coursesResult,
        notesResult,
        purchasesResult,
        paymentsResult
      ] = await Promise.all([
        supabase
          .from("students")
          .select("id", {
            count: "exact",
            head: true
          }),

        supabase
          .from("courses")
          .select("id", {
            count: "exact",
            head: true
          }),

        supabase
          .from("notes")
          .select("id", {
            count: "exact",
            head: true
          })
          .eq("is_active", true),

        supabase
          .from("purchases")
          .select("id", {
            count: "exact",
            head: true
          }),

        supabase
          .from("payments")
          .select(
            "amount_kobo,status"
          )
      ]);

      return res.json({
        success: true,
        statistics: {
          students:
            studentsResult.count || 0,
          courses:
            coursesResult.count || 0,
          active_notes:
            notesResult.count || 0,
          purchases:
            purchasesResult.count || 0,
          payments:
            paymentsResult.data || []
        }
      });

    } catch (error) {
      console.error(
        "ADMIN DASHBOARD ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to load admin dashboard"
      });
    }
  }
);

// ======================================================
// ADMIN STUDENTS
// ======================================================

app.get(
  "/api/admin/students",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        data,
        error
      } = await supabase
        .from("students")
        .select("*")
        .order("created_at", {
          ascending: false
        });

      if (error) throw error;

      return res.json({
        success: true,
        students: data || []
      });

    } catch (error) {
      return res.status(500).json({
        success: false,
        message:
          "Failed to load students"
      });
    }
  }
);

// ADMIN ACTIVATE / DEACTIVATE STUDENT

app.patch(
  "/api/admin/students/:id/status",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        is_active
      } = req.body;

      if (
        typeof is_active !==
        "boolean"
      ) {
        return res.status(400).json({
          success: false,
          message:
            "is_active must be true or false"
        });
      }

      const {
        data,
        error
      } = await supabase
        .from("students")
        .update({
          is_active
        })
        .eq("id", req.params.id)
        .select()
        .single();

      if (error) throw error;

      return res.json({
        success: true,
        student: data
      });

    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }
);

// ======================================================
// 404 HANDLER
// ======================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message:
      "Endpoint not found"
  });
});

// ======================================================
// ERROR HANDLER
// ======================================================

app.use(
  (error, req, res, next) => {
    console.error(
      "SERVER ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Internal server error"
    });
  }
);

// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, () => {
  console.log(
    `CampusConnect API running on port ${PORT}`
  );
});
