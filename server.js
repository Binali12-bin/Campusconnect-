const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

/*
|--------------------------------------------------------------------------
| Environment variables
|--------------------------------------------------------------------------
*/

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("Supabase environment variables are missing.");
}

if (!PAYSTACK_SECRET_KEY) {
  console.warn("PAYSTACK_SECRET_KEY is missing.");
}

/*
|--------------------------------------------------------------------------
| Supabase admin client
|--------------------------------------------------------------------------
*/

const supabaseAdmin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

/*
|--------------------------------------------------------------------------
| Basic health check
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "CampusConnect backend is running."
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "CampusConnect Backend",
    status: "healthy"
  });
});

/*
|--------------------------------------------------------------------------
| Authentication helper
|--------------------------------------------------------------------------
|
| The frontend sends:
|
| Authorization: Bearer SUPABASE_ACCESS_TOKEN
|
*/

async function authenticateStudent(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication token is required."
      });
    }

    const token = authHeader.replace("Bearer ", "").trim();

    const {
      data: { user },
      error
    } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired authentication token."
      });
    }

    const { data: student, error: studentError } =
      await supabaseAdmin
        .from("students")
        .select("*")
        .eq("auth_user_id", user.id)
        .single();

    if (studentError || !student) {
      return res.status(403).json({
        success: false,
        message: "Student profile was not found."
      });
    }

    if (student.is_active === false) {
      return res.status(403).json({
        success: false,
        message: "Your CampusConnect account is inactive."
      });
    }

    req.user = user;
    req.student = student;

    next();
  } catch (error) {
    console.error("Authentication error:", error);

    return res.status(500).json({
      success: false,
      message: "Authentication failed."
    });
  }
}

/*
|--------------------------------------------------------------------------
| Get current student
|--------------------------------------------------------------------------
*/

app.get("/api/student/me", authenticateStudent, async (req, res) => {
  return res.json({
    success: true,
    student: req.student
  });
});

/*
|--------------------------------------------------------------------------
| Paystack: Initialize wallet funding
|--------------------------------------------------------------------------
*/

app.post(
  "/api/paystack/initialize",
  authenticateStudent,
  async (req, res) => {
    try {
      const amountNaira = Number(req.body.amount_naira);

      if (!Number.isFinite(amountNaira) || amountNaira <= 0) {
        return res.status(400).json({
          success: false,
          message: "Enter a valid amount."
        });
      }

      if (amountNaira < 100) {
        return res.status(400).json({
          success: false,
          message: "Minimum wallet funding amount is ₦100."
        });
      }

      const amountKobo = Math.round(amountNaira * 100);

      const reference =
        "CC_" +
        Date.now() +
        "_" +
        crypto.randomBytes(5).toString("hex");

      /*
      Create a pending payment record first.
      */

      const { error: paymentError } = await supabaseAdmin
        .from("payments")
        .insert({
          student_id: req.student.id,
          reference: reference,
          amount_kobo: amountKobo,
          status: "pending",
          provider: "paystack"
        });

      if (paymentError) {
        console.error("Payment database error:", paymentError);

        return res.status(500).json({
          success: false,
          message: "Unable to create payment record."
        });
      }

      /*
      Send transaction initialization request to Paystack.
      */

      const paystackResponse = await fetch(
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
            reference: reference,
            metadata: {
              student_id: req.student.id,
              auth_user_id: req.user.id,
              purpose: "CampusConnect wallet funding"
            }
          })
        }
      );

      const paystackData = await paystackResponse.json();

      if (!paystackResponse.ok || !paystackData.status) {
        console.error("Paystack initialization error:", paystackData);

        await supabaseAdmin
          .from("payments")
          .update({
            status: "failed"
          })
          .eq("reference", reference);

        return res.status(400).json({
          success: false,
          message: "Paystack could not initialize the payment."
        });
      }

      return res.json({
        success: true,
        reference: reference,
        authorization_url: paystackData.data.authorization_url,
        access_code: paystackData.data.access_code
      });
    } catch (error) {
      console.error("Initialize payment error:", error);

      return res.status(500).json({
        success: false,
        message: "Payment initialization failed."
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Paystack: Verify payment
|--------------------------------------------------------------------------
*/

app.post(
  "/api/paystack/verify",
  authenticateStudent,
  async (req, res) => {
    try {
      const reference = String(req.body.reference || "").trim();

      if (!reference) {
        return res.status(400).json({
          success: false,
          message: "Payment reference is required."
        });
      }

      /*
      Find the payment belonging to this student.
      */

      const { data: payment, error: paymentError } =
        await supabaseAdmin
          .from("payments")
          .select("*")
          .eq("reference", reference)
          .eq("student_id", req.student.id)
          .single();

      if (paymentError || !payment) {
        return res.status(404).json({
          success: false,
          message: "Payment record was not found."
        });
      }

      /*
      Ask Paystack directly for the real transaction status.
      */

      const paystackResponse = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(
          reference
        )}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
          }
        }
      );

      const paystackData = await paystackResponse.json();

      if (!paystackResponse.ok || !paystackData.status) {
        return res.status(400).json({
          success: false,
          message: "Unable to verify payment with Paystack."
        });
      }

      const transaction = paystackData.data;

      /*
      Payment must actually be successful.
      */

      if (transaction.status !== "success") {
        await supabaseAdmin
          .from("payments")
          .update({
            status: transaction.status || "failed"
          })
          .eq("reference", reference);

        return res.status(400).json({
          success: false,
          message: "Payment has not been completed."
        });
      }

      /*
      IMPORTANT:
      The amount received from Paystack must exactly match
      the amount that CampusConnect expected.
      */

      if (Number(transaction.amount) !== Number(payment.amount_kobo)) {
        return res.status(400).json({
          success: false,
          message: "Payment amount does not match the CampusConnect payment."
        });
      }

      /*
      Prevent the same payment from crediting the wallet twice.
      */

      if (payment.status === "success") {
        return res.json({
          success: true,
          message: "Payment was already processed.",
          reference: reference
        });
      }

      /*
      Mark payment successful.
      */

      const { error: updatePaymentError } =
        await supabaseAdmin
          .from("payments")
          .update({
            status: "success",
            paid_at: new Date().toISOString()
          })
          .eq("reference", reference)
          .eq("student_id", req.student.id)
          .eq("status", "pending");

      if (updatePaymentError) {
        console.error(
          "Payment update error:",
          updatePaymentError
        );

        return res.status(500).json({
          success: false,
          message: "Unable to update payment."
        });
      }

      /*
      Credit the student's CampusConnect wallet.
      */

      const currentBalance =
        Number(req.student.wallet_balance_kobo || 0);

      const newBalance =
        currentBalance + Number(payment.amount_kobo);

      const { error: walletError } =
        await supabaseAdmin
          .from("students")
          .update({
            wallet_balance_kobo: newBalance
          })
          .eq("id", req.student.id);

      if (walletError) {
        console.error("Wallet update error:", walletError);

        /*
        The payment is already marked successful.
        We report the issue instead of pretending the wallet
        was credited.
        */

        return res.status(500).json({
          success: false,
          message:
            "Payment verified, but wallet credit requires administrator attention."
        });
      }

      /*
      Record wallet transaction.
      */

      const { error: transactionError } =
        await supabaseAdmin
          .from("wallet_transactions")
          .insert({
            student_id: req.student.id,
            type: "credit",
            amount_kobo: payment.amount_kobo,
            reference: reference,
            description: "Wallet funding via Paystack"
          });

      if (transactionError) {
        console.error(
          "Wallet transaction record error:",
          transactionError
        );
      }

      return res.json({
        success: true,
        message: "Payment verified and wallet credited.",
        reference: reference,
        amount_kobo: payment.amount_kobo,
        wallet_balance_kobo: newBalance
      });
    } catch (error) {
      console.error("Verify payment error:", error);

      return res.status(500).json({
        success: false,
        message: "Payment verification failed."
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Paystack Webhook
|--------------------------------------------------------------------------
*/

app.post(
  "/api/paystack/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-paystack-signature"];

      if (!signature) {
        return res.status(401).send("Missing signature");
      }

      const hash = crypto
        .createHmac("sha512", PAYSTACK_SECRET_KEY)
        .update(req.body)
        .digest("hex");

      if (hash !== signature) {
        return res.status(401).send("Invalid signature");
      }

      const event = JSON.parse(req.body.toString());

      /*
      We mainly care about successful charges.
      */

      if (event.event !== "charge.success") {
        return res.sendStatus(200);
      }

      const transaction = event.data;

      const reference = transaction.reference;

      if (!reference) {
        return res.sendStatus(200);
      }

      const { data: payment } =
        await supabaseAdmin
          .from("payments")
          .select("*")
          .eq("reference", reference)
          .single();

      if (!payment) {
        return res.sendStatus(200);
      }

      /*
      Ignore already processed payments.
      */

      if (payment.status === "success") {
        return res.sendStatus(200);
      }

      /*
      Confirm amount.
      */

      if (Number(transaction.amount) !== Number(payment.amount_kobo)) {
        console.error(
          "Webhook amount mismatch:",
          reference
        );

        return res.sendStatus(200);
      }

      /*
      Get student.
      */

      const { data: student } =
        await supabaseAdmin
          .from("students")
          .select("*")
          .eq("id", payment.student_id)
          .single();

      if (!student) {
        return res.sendStatus(200);
      }

      /*
      Mark payment successful.
      */

      await supabaseAdmin
        .from("payments")
        .update({
          status: "success",
          paid_at: new Date().toISOString()
        })
        .eq("reference", reference)
        .eq("status", "pending");

      /*
      Credit wallet.
      */

      const newBalance =
        Number(student.wallet_balance_kobo || 0) +
        Number(payment.amount_kobo);

      await supabaseAdmin
        .from("students")
        .update({
          wallet_balance_kobo: newBalance
        })
        .eq("id", student.id);

      /*
      Record wallet transaction.
      */

      await supabaseAdmin
        .from("wallet_transactions")
        .insert({
          student_id: student.id,
          type: "credit",
          amount_kobo: payment.amount_kobo,
          reference: reference,
          description: "Wallet funding via Paystack"
        });

      console.log(
        `Wallet credited successfully: ${reference}`
      );

      return res.sendStatus(200);
    } catch (error) {
      console.error("Webhook error:", error);

      return res.sendStatus(500);
    }
  }
);

/*
|--------------------------------------------------------------------------
| Get wallet balance
|--------------------------------------------------------------------------
*/

app.get(
  "/api/wallet",
  authenticateStudent,
  async (req, res) => {
    try {
      const { data: student, error } =
        await supabaseAdmin
          .from("students")
          .select("wallet_balance_kobo")
          .eq("id", req.student.id)
          .single();

      if (error || !student) {
        return res.status(404).json({
          success: false,
          message: "Wallet not found."
        });
      }

      return res.json({
        success: true,
        wallet_balance_kobo:
          Number(student.wallet_balance_kobo || 0)
      });
    } catch (error) {
      console.error("Wallet error:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to load wallet."
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Get courses
|--------------------------------------------------------------------------
*/

app.get(
  "/api/courses",
  authenticateStudent,
  async (req, res) => {
    try {
      const { data, error } =
        await supabaseAdmin
          .from("courses")
          .select("*")
          .order("course_code");

      if (error) {
        return res.status(500).json({
          success: false,
          message: "Unable to load courses."
        });
      }

      return res.json({
        success: true,
        courses: data || []
      });
    } catch (error) {
      console.error("Courses error:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to load courses."
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Get active marketplace notes
|--------------------------------------------------------------------------
*/

app.get(
  "/api/notes",
  authenticateStudent,
  async (req, res) => {
    try {
      const search = String(req.query.search || "")
        .trim()
        .toLowerCase();

      let query = supabaseAdmin
        .from("notes")
        .select(`
          *,
          courses (
            course_code,
            course_title
          )
        `)
        .eq("is_active", true)
        .order("created_at", {
          ascending: false
        });

      const { data, error } = await query;

      if (error) {
        console.error("Notes error:", error);

        return res.status(500).json({
          success: false,
          message: "Unable to load notes."
        });
      }

      let notes = data || [];

      if (search) {
        notes = notes.filter((note) => {
          const courseCode =
            note.courses?.course_code || "";

          const courseTitle =
            note.courses?.course_title || "";

          return (
            String(note.title || "")
              .toLowerCase()
              .includes(search) ||
            String(note.description || "")
              .toLowerCase()
              .includes(search) ||
            String(courseCode)
              .toLowerCase()
              .includes(search) ||
            String(courseTitle)
              .toLowerCase()
              .includes(search)
          );
        });
      }

      return res.json({
        success: true,
        notes: notes
      });
    } catch (error) {
      console.error("Notes error:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to load notes."
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Get student's purchases / library
|--------------------------------------------------------------------------
*/

app.get(
  "/api/library",
  authenticateStudent,
  async (req, res) => {
    try {
      const { data, error } =
        await supabaseAdmin
          .from("purchases")
          .select(`
            *,
            notes (
              id,
              title,
              description,
              price_kobo,
              file_url,
              courses (
                course_code,
                course_title
              )
            )
          `)
          .eq("student_id", req.student.id)
          .order("created_at", {
            ascending: false
          });

      if (error) {
        console.error("Library error:", error);

        return res.status(500).json({
          success: false,
          message: "Unable to load library."
        });
      }

      return res.json({
        success: true,
        library: data || []
      });
    } catch (error) {
      console.error("Library error:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to load library."
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Start server
|--------------------------------------------------------------------------
*/

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(
    `CampusConnect backend running on port ${PORT}`
  );
});
