import express from 'express';
import path from 'path';
import { fileURLToPath } from "url";
import crypto from "crypto";
import mongoose from 'mongoose';
import nodemailer from "nodemailer";
import {User} from './src/routes/modals/users.js';
import Recipe from './src/routes/modals/recipe.js';
import PendingRecipe from './src/routes/modals/pendingRecipe.js';
import AppSettings from './src/routes/modals/appSettings.js';

try {
    const dotenv = await import("dotenv");
    dotenv.config();
} catch {
    // dotenv is optional; env vars may be provided by the shell.
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app=express();
const port = Number(process.env.PORT || 4000);
const host = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";

function normalizeBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
}

const APP_BASE_URL = normalizeBaseUrl(process.env.APP_BASE_URL);

app.set("trust proxy", true);

app.use(express.urlencoded({extended:true}));
app.use(express.json());

import multer from "multer";

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  }
});

const upload = multer({ storage });

// serve uploaded images
app.use("/uploads", express.static("uploads"));

const MEALDB_KEY = process.env.MEALDB_KEY || "1";
const MEALDB_BASE = `https://www.themealdb.com/api/json/v1/${MEALDB_KEY}`;
const MEALDB_TIMEOUT_MS = Number(process.env.MEALDB_TIMEOUT_MS || 8000);
const MEALDB_ALL_TTL_MS = 1000 * 60 * 60 * 6;
const MEALDB_SEARCH_TTL_MS = 1000 * 60 * 15;
const MEALDB_FILTERS_TTL_MS = 1000 * 60 * 60 * 24;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 20000);
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS || 20000);
const HAS_LLM = Boolean(GROQ_API_KEY || OPENAI_API_KEY);
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || "no-reply@recipefinder.local";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || MAIL_FROM || "onboarding@resend.dev";
const RESEND_TIMEOUT_MS = Number(process.env.RESEND_TIMEOUT_MS || 10000);
const PAYMENT_OTP_TTL_MS = Number(process.env.PAYMENT_OTP_TTL_MS || 5 * 60 * 1000);
const PASSWORD_RESET_OTP_TTL_MS = Number(process.env.PASSWORD_RESET_OTP_TTL_MS || 10 * 60 * 1000);
const EMAIL_VERIFICATION_TOKEN_TTL_MS = Number(process.env.EMAIL_VERIFICATION_TOKEN_TTL_MS || 24 * 60 * 60 * 1000);
const ADMIN_CONTACT_EMAIL = process.env.ADMIN_CONTACT_EMAIL || "hamethanasren@gmail.com";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@gmail.com").trim().toLowerCase();
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((entry) => normalizeText(entry).toLowerCase())
    .filter(Boolean);
const ADMIN_EMAIL_SET = new Set(
    [
        ADMIN_EMAIL,
        normalizeText(ADMIN_CONTACT_EMAIL).toLowerCase(),
        normalizeText(SMTP_USER).toLowerCase(),
        ...ADMIN_EMAILS
    ].filter(Boolean)
);
const PREMIUM_DEFAULT_AMOUNT = Number(process.env.PREMIUM_DEFAULT_AMOUNT || 199);
const PREMIUM_DEFAULT_CURRENCY = (process.env.PREMIUM_DEFAULT_CURRENCY || "INR").trim().toUpperCase();
const PREMIUM_MIN_DURATION_DAYS = 1 / 24; // 1 hour
const rawPremiumDefaultDurationDays = Number(process.env.PREMIUM_DEFAULT_DURATION_DAYS || 30);
const PREMIUM_DEFAULT_DURATION_DAYS = Number.isFinite(rawPremiumDefaultDurationDays) && rawPremiumDefaultDurationDays > 0
    ? Math.max(PREMIUM_MIN_DURATION_DAYS, rawPremiumDefaultDurationDays)
    : 30;
const PREMIUM_EXPIRY_SWEEP_MS = Math.max(60 * 1000, Number(process.env.PREMIUM_EXPIRY_SWEEP_MS || 5 * 60 * 1000));

const PREMIUM_STATUS = Object.freeze({
    NONE: "none",
    PAYMENT_PENDING_APPROVAL: "payment_pending_approval",
    ACTIVE: "active",
    EXPIRED: "expired",
    REVOKED: "revoked"
});

const externalCache = {
    allMeals: { data: null, fetchedAt: 0 },
    filters: { data: null, fetchedAt: 0 },
    search: new Map(),
    ingredients: new Map()
};

const mockPayments = new Map();
const passwordResetOtps = new Map();
let mailTransporter = null;

function createPaymentId() {
    return `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generatePaymentOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function maskEmail(email) {
    const normalized = normalizeText(email).toLowerCase();
    const [name, domain] = normalized.split("@");
    if (!name || !domain) {
        return normalized;
    }
    if (name.length <= 2) {
        return `${name[0] || "*"}*@${domain}`;
    }
    return `${name.slice(0, 2)}${"*".repeat(Math.max(1, name.length - 2))}@${domain}`;
}

function isOtpMailConfigured() {
    if (hasResendConfig()) {
        return true;
    }
    return hasValidSmtpConfig();
}

function hasValidSmtpConfig() {
    const pass = normalizeText(SMTP_PASS);
    if (!pass || pass.includes("YOUR_16_CHAR_APP_PASSWORD")) {
        return false;
    }
    return Boolean(SMTP_HOST && SMTP_USER && pass);
}

function hasResendConfig() {
    const key = normalizeText(RESEND_API_KEY);
    if (!key || key.includes("YOUR_RESEND_API_KEY")) {
        return false;
    }
    return true;
}

function getMailTransporter() {
    if (mailTransporter) {
        return mailTransporter;
    }
    mailTransporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: {
            user: SMTP_USER,
            pass: SMTP_PASS
        }
    });
    return mailTransporter;
}

async function sendEmailViaResend({ to, subject, text, html }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
    try {
        const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${RESEND_API_KEY}`
            },
            body: JSON.stringify({
                from: RESEND_FROM,
                to: [to],
                subject,
                html,
                text
            }),
            signal: controller.signal
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`Resend API error: ${res.status} ${errText}`);
        }
    } finally {
        clearTimeout(timeout);
    }
}

async function sendEmailViaSmtp({ to, subject, text, html }) {
    const transporter = getMailTransporter();
    await transporter.sendMail({
        from: MAIL_FROM,
        to,
        subject,
        text,
        html
    });
}

async function sendTransactionalEmail({ to, subject, text, html }) {
    if (hasResendConfig()) {
        try {
            await sendEmailViaResend({ to, subject, text, html });
            return;
        } catch (resendErr) {
            if (!hasValidSmtpConfig()) {
                throw resendErr;
            }
            console.error("Resend mail error, attempting SMTP fallback:", resendErr);
        }
    }
    await sendEmailViaSmtp({ to, subject, text, html });
}

function buildOtpMailPayload({ otp, planName, amount, currency }) {
    return {
        subject: "Recipe Finder Premium OTP",
        text: [
            `Your Premium payment verification OTP is: ${otp}`,
            `Plan: ${planName}`,
            `Amount: ${amount} ${currency}`,
            `This OTP is valid for ${Math.floor(PAYMENT_OTP_TTL_MS / 60000)} minutes.`
        ].join("\n"),
        html: `
            <div style="font-family:Arial,sans-serif;line-height:1.6">
              <h2>Recipe Finder Premium OTP</h2>
              <p>Your verification OTP is:</p>
              <p style="font-size:26px;font-weight:700;letter-spacing:2px">${otp}</p>
              <p>Plan: <b>${planName}</b></p>
              <p>Amount: <b>${amount} ${currency}</b></p>
              <p>OTP valid for ${Math.floor(PAYMENT_OTP_TTL_MS / 60000)} minutes.</p>
            </div>
        `
    };
}

async function sendPaymentOtpViaResend({ email, otp, planName, amount, currency }) {
    const payload = buildOtpMailPayload({ otp, planName, amount, currency });
    await sendEmailViaResend({
        to: email,
        subject: payload.subject,
        text: payload.text,
        html: payload.html
    });
}

async function sendPaymentOtpViaSmtp({ email, otp, planName, amount, currency }) {
    const payload = buildOtpMailPayload({ otp, planName, amount, currency });
    await sendEmailViaSmtp({
        to: email,
        subject: payload.subject,
        text: payload.text,
        html: payload.html
    });
}

async function sendPaymentOtpEmail({ email, otp, planName, amount, currency }) {
    if (hasResendConfig()) {
        try {
            await sendPaymentOtpViaResend({ email, otp, planName, amount, currency });
            return;
        } catch (resendErr) {
            if (!hasValidSmtpConfig()) {
                throw resendErr;
            }
            console.error("Resend OTP error, attempting SMTP fallback:", resendErr);
        }
    }
    await sendPaymentOtpViaSmtp({ email, otp, planName, amount, currency });
}

function getOtpConfigHint() {
    return "Configure one provider: RESEND_API_KEY + RESEND_FROM, or SMTP_USER + Gmail App Password in SMTP_PASS.";
}

function getMailErrorHint(err) {
    const rawMessage = normalizeText(err?.message).toLowerCase();
    const code = normalizeText(err?.code).toUpperCase();
    const responseCode = Number(err?.responseCode);
    if (rawMessage.includes("resend api error: 401")) {
        return "Resend API key is invalid. Set a valid RESEND_API_KEY.";
    }
    if (rawMessage.includes("resend api error: 403")) {
        return "Resend sender is not verified. Set RESEND_FROM to a verified sender/domain.";
    }
    if (rawMessage.includes("resend api error: 422")) {
        return "Resend request invalid. Check RESEND_FROM format and recipient email.";
    }
    if (code === "EAUTH" || responseCode === 535) {
        return "SMTP auth failed. Use Gmail App Password (not account password), and keep SMTP_SECURE=false, SMTP_PORT=587.";
    }
    if (code === "ECONNECTION" || code === "ETIMEDOUT") {
        return "SMTP connection failed. Check SMTP_HOST/SMTP_PORT and network access.";
    }
    if (responseCode === 550 || responseCode === 553) {
        return "Sender/recipient blocked by provider. Verify MAIL_FROM and recipient address.";
    }
    return "Unable to send email. Check SMTP credentials and provider settings.";
}

function cleanupExpiredPasswordResetOtps() {
    const now = Date.now();
    for (const [email, entry] of passwordResetOtps.entries()) {
        if (now > Number(entry?.expiresAt || 0)) {
            passwordResetOtps.delete(email);
        }
    }
}

function cleanupExpiredMockPayments() {
    const now = Date.now();
    for (const [paymentId, payment] of mockPayments.entries()) {
        if (now > Number(payment?.otpExpiresAt || 0)) {
            mockPayments.delete(paymentId);
        }
    }
}

function buildPasswordResetOtpPayload({ otp }) {
    const minutes = Math.max(1, Math.floor(PASSWORD_RESET_OTP_TTL_MS / 60000));
    return {
        subject: "Recipe Finder Password Reset OTP",
        text: [
            `Your password reset OTP is: ${otp}`,
            `This OTP is valid for ${minutes} minutes.`,
            "If you did not request this, please ignore this email."
        ].join("\n"),
        html: `
            <div style="font-family:Arial,sans-serif;line-height:1.6">
              <h2>Recipe Finder Password Reset</h2>
              <p>Use this OTP to reset your password:</p>
              <p style="font-size:26px;font-weight:700;letter-spacing:2px">${otp}</p>
              <p>OTP valid for ${minutes} minutes.</p>
            </div>
        `
    };
}

function isUserEmailVerified(user) {
    return user?.emailVerified !== false;
}

function clearEmailVerificationToken(user) {
    user.emailVerificationToken = "";
    user.emailVerificationTokenExpiresAt = null;
    user.emailVerificationRequestedAt = null;
}

function buildEmailVerificationMailPayload({ name, verifyUrl }) {
    const hours = Math.max(1, Math.floor(EMAIL_VERIFICATION_TOKEN_TTL_MS / (60 * 60 * 1000)));
    const safeName = normalizeText(name) || "there";
    return {
        subject: "Verify your Recipe Finder account",
        text: [
            `Hi ${safeName},`,
            "",
            "Please verify your email by opening the link below:",
            verifyUrl,
            "",
            `This link is valid for ${hours} hours.`,
            "",
            "If you did not create this account, please ignore this email."
        ].join("\n"),
        html: `
            <div style="font-family:Arial,sans-serif;line-height:1.6">
              <h2>Recipe Finder Email Verification</h2>
              <p>Hi ${safeName},</p>
              <p>Click below to verify your email address:</p>
              <p>
                <a href="${verifyUrl}" style="display:inline-block;padding:12px 18px;background:#d4af37;color:#111;text-decoration:none;border-radius:8px;font-weight:600">
                  Verify Email
                </a>
              </p>
              <p>Or copy this link in your browser:</p>
              <p style="word-break:break-all">${verifyUrl}</p>
              <p>This link is valid for ${hours} hours.</p>
            </div>
        `
    };
}

app.use((req, res, next) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  next();
});

function resolveRequestBaseUrl(req) {
    if (!req) {
        return "";
    }
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
    const protocol = forwardedProto || req.protocol || "http";
    const hostHeader = forwardedHost || req.get("host");
    if (!hostHeader) {
        return "";
    }
    return normalizeBaseUrl(`${protocol}://${hostHeader}`);
}

function resolveAppBaseUrl(req) {
    return APP_BASE_URL || resolveRequestBaseUrl(req) || `http://localhost:${port}`;
}

function buildEmailVerificationLink({ email, token, baseUrl }) {
    const encodedEmail = encodeURIComponent(email);
    const encodedToken = encodeURIComponent(token);
    const safeBaseUrl = normalizeBaseUrl(baseUrl) || resolveAppBaseUrl();
    return `${safeBaseUrl}/api/auth/email-verification/confirm?email=${encodedEmail}&token=${encodedToken}`;
}

async function issueEmailVerificationMail(user, req) {
    const token = crypto.randomBytes(32).toString("hex");
    user.emailVerificationToken = token;
    user.emailVerificationTokenExpiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS);
    user.emailVerificationRequestedAt = new Date();
    await user.save();

    const verifyUrl = buildEmailVerificationLink({ email: user.email, token, baseUrl: resolveAppBaseUrl(req) });
    const payload = buildEmailVerificationMailPayload({ name: user.name, verifyUrl });
    await sendTransactionalEmail({
        to: user.email,
        subject: payload.subject,
        text: payload.text,
        html: payload.html
    });

    return {
        sentTo: maskEmail(user.email),
        verifyLinkExpiresInSeconds: Math.floor(EMAIL_VERIFICATION_TOKEN_TTL_MS / 1000)
    };
}

function buildRecipeDecisionMailPayload({ recipeTitle, status, note }) {
    const prettyStatus = status === "approved" ? "approved" : "rejected";
    const successNote = "Success: Your recipe was approved and is now visible to users.";
    const effectiveNote = normalizeText(note) || (prettyStatus === "approved" ? successNote : "");
    return {
        subject: `Recipe Submission ${prettyStatus.toUpperCase()}`,
        text: [
            `Your recipe submission "${recipeTitle}" was ${prettyStatus}.`,
            effectiveNote ? `Admin note: ${effectiveNote}` : "",
            "Thank you for contributing to Recipe Finder."
        ].filter(Boolean).join("\n"),
        html: `
            <div style="font-family:Arial,sans-serif;line-height:1.6">
              <h2>Recipe Submission Update</h2>
              <p>Your recipe <b>${recipeTitle}</b> was <b>${prettyStatus}</b>.</p>
              ${effectiveNote ? `<p>Admin note: ${effectiveNote}</p>` : ""}
              <p>Thank you for contributing to Recipe Finder.</p>
            </div>
        `
    };
}

function buildVerificationNote({ status, manualNote, recipe }) {
    const cleanManual = normalizeText(manualNote);
    if (cleanManual) {
        return cleanManual;
    }
    if (status === "approved") {
        return "Success: Your recipe was approved and is now visible to users.";
    }
    const aiSummary = normalizeText(recipe?.aiReview?.summary);
    const aiIssues = Array.isArray(recipe?.aiReview?.issues)
        ? recipe.aiReview.issues.map((item) => normalizeText(item)).filter(Boolean)
        : [];
    const issueLine = aiIssues.length ? `AI issues: ${aiIssues.join("; ")}` : "";
    const merged = [aiSummary, issueLine].filter(Boolean).join(" | ");
    return merged || "Recipe rejected after AI quality check. Please improve and resubmit.";
}

function buildUserSubmissionStatusMessage(recipe) {
    const status = sanitizeRecipeStatus(recipe?.status, "pending");
    const note = normalizeText(recipe?.verificationNote);
    if (status === "approved") {
        return note || "Success: Your recipe was approved successfully.";
    }
    if (status === "rejected") {
        return note || "Recipe was rejected. Please review feedback and resubmit.";
    }
    return "Your recipe is under admin review.";
}

function buildAdminContactPayload({ fromName, fromEmail, message }) {
    const safeName = normalizeText(fromName) || "Recipe Finder User";
    const safeEmail = normalizeText(fromEmail) || "unknown@email";
    const safeMessage = normalizeText(message);
    return {
        subject: `Contact Request from ${safeName}`,
        text: [
            `Name: ${safeName}`,
            `Email: ${safeEmail}`,
            "",
            safeMessage
        ].join("\n"),
        html: `
            <div style="font-family:Arial,sans-serif;line-height:1.6">
              <h2>Recipe Finder Contact Request</h2>
              <p><b>Name:</b> ${safeName}</p>
              <p><b>Email:</b> ${safeEmail}</p>
              <p><b>Message:</b></p>
              <p>${safeMessage.replace(/\n/g, "<br>")}</p>
            </div>
        `
    };
}

function buildAdminBroadcastPayload({ subject, message }) {
    const safeSubject = normalizeText(subject) || "Recipe Finder Admin Update";
    const safeMessage = normalizeText(message);
    return {
        subject: safeSubject,
        text: safeMessage,
        html: `
            <div style="font-family:Arial,sans-serif;line-height:1.6">
              <h2>${safeSubject}</h2>
              <p>${safeMessage.replace(/\n/g, "<br>")}</p>
            </div>
        `
    };
}

function sanitizeRecipeStatus(value, fallback = "pending") {
    const normalized = normalizeText(value).toLowerCase();
    if (normalized === "approved" || normalized === "rejected" || normalized === "pending") {
        return normalized;
    }
    return fallback;
}

function sanitizeAiDecision(value) {
    const normalized = normalizeText(value).toLowerCase();
    if (normalized === "approve" || normalized === "reject" || normalized === "review") {
        return normalized;
    }
    return "review";
}

function parseBoolean(value) {
    if (typeof value === "boolean") {
        return value;
    }
    const normalized = normalizeText(value).toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
}

function normalizeCurrency(value, fallback = PREMIUM_DEFAULT_CURRENCY) {
    const clean = normalizeText(value).toUpperCase();
    if (!clean || clean.length > 6) {
        return fallback;
    }
    return clean;
}

function sanitizePremiumAmount(value, fallback = PREMIUM_DEFAULT_AMOUNT) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.round(parsed * 100) / 100;
}

function isAdminEmail(value) {
    return ADMIN_EMAIL_SET.has(normalizeText(value).toLowerCase());
}

function normalizePlanId(value, fallback = "") {
    const normalized = normalizeText(value)
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return normalized || fallback;
}

function sanitizePremiumDurationDays(value, fallback = PREMIUM_DEFAULT_DURATION_DAYS) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
        return Math.max(PREMIUM_MIN_DURATION_DAYS, Math.round(parsed * 1000000) / 1000000);
    }
    const fallbackParsed = Number(fallback);
    if (Number.isFinite(fallbackParsed) && fallbackParsed > 0) {
        return Math.max(PREMIUM_MIN_DURATION_DAYS, fallbackParsed);
    }
    return PREMIUM_DEFAULT_DURATION_DAYS;
}

function parsePremiumPlanDurationDays(rawDurationDays, rawDurationHours) {
    const parsedDurationHours = Number(rawDurationHours);
    const durationSource = Number.isFinite(parsedDurationHours) && parsedDurationHours > 0
        ? parsedDurationHours / 24
        : rawDurationDays;
    const parsed = Number(durationSource);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return Math.max(PREMIUM_MIN_DURATION_DAYS, Math.round(parsed * 1000000) / 1000000);
}

function isOneTimeTestPlanHint(planId, planName) {
    const source = `${normalizeText(planId)} ${normalizeText(planName)}`.toLowerCase();
    return source.includes("test");
}

function sanitizePremiumPlan(rawPlan = {}, index = 0) {
    const normalizedName = normalizeText(rawPlan.name);
    const amount = Number(rawPlan.amount);
    const normalizedCurrency = normalizeCurrency(rawPlan.currency, "");
    const durationDays = parsePremiumPlanDurationDays(rawPlan.durationDays, rawPlan.durationHours);
    const normalizedId = normalizePlanId(rawPlan.id || rawPlan.code || rawPlan.name || `plan_${index + 1}`);
    const oneTimePerUser = parseBoolean(rawPlan.oneTimePerUser) || isOneTimeTestPlanHint(normalizedId, normalizedName);
    if (!normalizedId || !normalizedName || !Number.isFinite(amount) || amount <= 0 || !normalizedCurrency || !durationDays) {
        return null;
    }
    return {
        id: normalizedId,
        name: normalizedName,
        amount: Math.round(amount * 100) / 100,
        currency: normalizedCurrency,
        durationDays,
        oneTimePerUser
    };
}

function sanitizePremiumPlanList(rawPlans) {
    const list = Array.isArray(rawPlans) ? rawPlans : [];
    const mapped = list
        .map((item, index) => sanitizePremiumPlan(item, index))
        .filter(Boolean);
    const deduped = [];
    const seen = new Set();
    mapped.forEach((plan, index) => {
        let candidateId = normalizePlanId(plan.id, `plan_${index + 1}`);
        let guard = 2;
        while (seen.has(candidateId)) {
            candidateId = `${candidateId}_${guard}`;
            guard += 1;
        }
        seen.add(candidateId);
        deduped.push({
            ...plan,
            id: candidateId
        });
    });
    return deduped;
}

function findPremiumPlanById(plans, requestedPlanId) {
    const normalizedRequested = normalizePlanId(requestedPlanId);
    if (!Array.isArray(plans) || !plans.length) {
        return null;
    }
    if (!normalizedRequested) {
        return plans[0];
    }
    return plans.find((plan) => normalizePlanId(plan.id) === normalizedRequested) || plans[0];
}

function getUsedOneTimePlanIdSet(user) {
    const rawList = Array.isArray(user?.usedOneTimePlanIds) ? user.usedOneTimePlanIds : [];
    return new Set(
        rawList
            .map((entry) => normalizePlanId(entry))
            .filter(Boolean)
    );
}

function filterPlansForUser(plans, user) {
    const usedIds = getUsedOneTimePlanIdSet(user);
    if (!usedIds.size) {
        return Array.isArray(plans) ? plans : [];
    }
    return (Array.isArray(plans) ? plans : []).filter((plan) => {
        if (!plan?.oneTimePerUser) {
            return true;
        }
        const planId = normalizePlanId(plan.id);
        return !planId || !usedIds.has(planId);
    });
}

async function getPremiumPlansConfig() {
    const settings = await AppSettings.findOne({ key: "premium_plans" }).lean();
    if (!settings) {
        return {
            plans: [],
            defaultPlanId: ""
        };
    }

    const rawValue = settings.value && typeof settings.value === "object" ? settings.value : {};
    const plans = sanitizePremiumPlanList(rawValue.plans);
    let defaultPlanId = normalizePlanId(rawValue.defaultPlanId);

    if (plans.length && (!defaultPlanId || !plans.some((plan) => plan.id === defaultPlanId))) {
        defaultPlanId = plans[0].id;
    } else if (!plans.length) {
        defaultPlanId = "";
    }

    return {
        plans,
        defaultPlanId
    };
}

async function savePremiumPlansConfig({ plans, defaultPlanId }) {
    const rawPlans = Array.isArray(plans) ? plans : [];
    const normalizedPlans = sanitizePremiumPlanList(plans);
    if (rawPlans.length && normalizedPlans.length !== rawPlans.length) {
        throw new Error("Failed to sanitize premium plans");
    }
    if (!normalizedPlans.length) {
        throw new Error("At least one premium plan is required.");
    }
    const normalizedDefault = normalizePlanId(defaultPlanId);
    const finalDefault = normalizedPlans.some((plan) => plan.id === normalizedDefault)
        ? normalizedDefault
        : normalizedPlans[0].id;

    const value = {
        plans: normalizedPlans,
        defaultPlanId: finalDefault
    };

    await AppSettings.findOneAndUpdate(
        { key: "premium_plans" },
        {
            $set: { value },
            $setOnInsert: { key: "premium_plans" }
        },
        {
            upsert: true,
            new: true,
            runValidators: true,
            setDefaultsOnInsert: true
        }
    );
    return value;
}

async function getPremiumPlanConfig() {
    const { plans, defaultPlanId } = await getPremiumPlansConfig();
    const selectedPlan = findPremiumPlanById(plans, defaultPlanId);
    if (!selectedPlan) {
        return null;
    }
    return {
        id: selectedPlan.id,
        amount: selectedPlan.amount,
        currency: selectedPlan.currency,
        name: selectedPlan.name,
        durationDays: selectedPlan.durationDays
    };
}

function resolvePremiumStatus(user) {
    const rawStatus = normalizeText(user?.premiumStatus).toLowerCase();
    if (rawStatus === PREMIUM_STATUS.PAYMENT_PENDING_APPROVAL) {
        return PREMIUM_STATUS.PAYMENT_PENDING_APPROVAL;
    }
    if (rawStatus === PREMIUM_STATUS.REVOKED) {
        return PREMIUM_STATUS.REVOKED;
    }
    if (rawStatus === PREMIUM_STATUS.EXPIRED) {
        return PREMIUM_STATUS.EXPIRED;
    }
    if (Boolean(user?.premium)) {
        return PREMIUM_STATUS.ACTIVE;
    }
    return PREMIUM_STATUS.NONE;
}

function addDays(date, days) {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

async function expirePremiumAccessIfNeeded(user) {
    if (!user) {
        return user;
    }
    const isMongooseDoc = typeof user.save === "function";
    const now = new Date();
    let changed = false;

    if (Boolean(user.premium)) {
        if (!user.premiumExpiresAt) {
            const baseDate = user.premiumActivatedAt ? new Date(user.premiumActivatedAt) : now;
            const durationDays = sanitizePremiumDurationDays(user.premiumDurationDays, PREMIUM_DEFAULT_DURATION_DAYS);
            user.premiumExpiresAt = addDays(baseDate, durationDays);
            if (resolvePremiumStatus(user) !== PREMIUM_STATUS.ACTIVE) {
                user.premiumStatus = PREMIUM_STATUS.ACTIVE;
            }
            changed = true;
        } else if (new Date(user.premiumExpiresAt).getTime() <= now.getTime()) {
            user.premium = false;
            user.premiumStatus = PREMIUM_STATUS.EXPIRED;
            user.premiumActivatedAt = null;
            user.premiumGrantedBy = "";
            user.premiumRevokedAt = null;
            user.premiumRevokedBy = "";
            changed = true;
        } else if (resolvePremiumStatus(user) !== PREMIUM_STATUS.ACTIVE) {
            user.premiumStatus = PREMIUM_STATUS.ACTIVE;
            changed = true;
        }
    } else if (normalizeText(user.premiumStatus) === "") {
        user.premiumStatus = PREMIUM_STATUS.NONE;
        changed = true;
    }

    if (changed && isMongooseDoc) {
        await user.save();
    }
    return user;
}

async function expirePremiumAccessForAllUsers() {
    const now = new Date();
    const result = await User.updateMany(
        { premium: true, premiumExpiresAt: { $lte: now } },
        {
            $set: {
                premium: false,
                premiumStatus: PREMIUM_STATUS.EXPIRED,
                premiumActivatedAt: null,
                premiumGrantedBy: "",
                premiumRevokedAt: null,
                premiumRevokedBy: ""
            }
        }
    );
    return Number(result?.modifiedCount || 0);
}

function buildPremiumSnapshot(user) {
    const status = resolvePremiumStatus(user);
    const premiumActive = status === PREMIUM_STATUS.ACTIVE && Boolean(user?.premium);
    const premiumDurationDays = Number(user?.premiumDurationDays) || 0;
    return {
        premium: premiumActive,
        premiumStatus: status,
        premiumPendingApproval: status === PREMIUM_STATUS.PAYMENT_PENDING_APPROVAL,
        premiumPlanId: normalizeText(user?.premiumPlanId),
        premiumPlanName: normalizeText(user?.premiumPlanName),
        premiumDurationDays,
        premiumDurationHours: premiumDurationDays > 0
            ? Math.round(premiumDurationDays * 24 * 100) / 100
            : 0,
        premiumAmount: Number(user?.premiumAmount) || 0,
        premiumCurrency: normalizeText(user?.premiumCurrency),
        premiumExpiresAt: user?.premiumExpiresAt || null
    };
}

function isFresh(entry, ttlMs) {
    if (!entry || !entry.fetchedAt) {
        return false;
    }
    return (Date.now() - entry.fetchedAt) < ttlMs;
}

function normalizeText(value) {
    return String(value || "").trim();
}

function normalizeForSearch(value) {
    return normalizeText(value)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function levenshteinDistance(a, b) {
    if (a === b) {
        return 0;
    }
    if (!a) {
        return b.length;
    }
    if (!b) {
        return a.length;
    }
    const matrix = Array.from({ length: a.length + 1 }, () => []);
    for (let i = 0; i <= a.length; i += 1) {
        matrix[i][0] = i;
    }
    for (let j = 0; j <= b.length; j += 1) {
        matrix[0][j] = j;
    }
    for (let i = 1; i <= a.length; i += 1) {
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }
    return matrix[a.length][b.length];
}

function findClosestMeals(query, meals, limit = 6) {
    const q = normalizeForSearch(query);
    if (!q) {
        return [];
    }
    const scored = meals
        .map((meal) => {
            const title = normalizeForSearch(meal?.title || meal?.strMeal || "");
            if (!title) {
                return null;
            }
            let score = 999;
            if (title.includes(q)) {
                score = 0;
            } else if (q.includes(title)) {
                score = 1;
            } else {
                score = levenshteinDistance(q, title);
            }
            return { meal, score };
        })
        .filter(Boolean)
        .sort((a, b) => a.score - b.score);

    const threshold = Math.max(2, Math.ceil(q.length / 3));
    return scored
        .filter((item) => item.score <= threshold)
        .slice(0, limit)
        .map((item) => item.meal);
}

function buildUnsplashImage(title) {
    const safe = normalizeText(title);
    if (!safe) {
        return "https://source.unsplash.com/featured/?recipe";
    }
    return `https://source.unsplash.com/featured/?${encodeURIComponent(safe)}`;
}

function safeParseJson(text) {
    if (!text) {
        return null;
    }
    const trimmed = String(text).trim();
    try {
        return JSON.parse(trimmed);
    } catch {
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(trimmed.slice(start, end + 1));
            } catch {
                return null;
            }
        }
        return null;
    }
}

function extractResponseText(data) {
    const output = data?.output || [];
    for (const item of output) {
        if (item?.type === "message" && item?.role === "assistant") {
            const content = item?.content || [];
            for (const part of content) {
                if (part?.type === "output_text") {
                    return part.text || "";
                }
            }
        }
    }
    return "";
}

function extractGroqText(data) {
    return normalizeText(data?.choices?.[0]?.message?.content || "");
}

function promptItemsToMessages(promptItems = []) {
    return promptItems.map((item) => {
        const contentParts = Array.isArray(item.content) ? item.content : [];
        const text = contentParts
            .map((part) => normalizeText(part?.text || part?.input_text))
            .filter(Boolean)
            .join("\n");
        return {
            role: item.role,
            content: text
        };
    });
}

function normalizeIngredientList(ingredients = []) {
    return ingredients
        .map((item) => normalizeText(item))
        .filter(Boolean)
        .slice(0, 10);
}

function normalizeIngredientName(value) {
    return normalizeText(value)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function sanitizeIngredientInput(raw) {
    const list = Array.isArray(raw)
        ? raw
        : String(raw || "").split(",");
    const seen = new Set();
    const clean = [];
    list.forEach((item) => {
        const text = normalizeText(item);
        const normalized = normalizeIngredientName(text);
        if (!normalized || seen.has(normalized)) {
            return;
        }
        seen.add(normalized);
        clean.push(text);
    });
    return clean.slice(0, 15);
}

function ingredientMatchesProvided(name, providedNormalized) {
    const normalized = normalizeIngredientName(name);
    if (!normalized) {
        return false;
    }
    return providedNormalized.some((item) => normalized.includes(item) || item.includes(normalized));
}

function isStrictIngredientRecipe(recipe, providedNormalized) {
    const ingredients = Array.isArray(recipe?.ingredients) ? recipe.ingredients : [];
    if (!ingredients.length) {
        return false;
    }
    return ingredients.every((item) => ingredientMatchesProvided(item?.name, providedNormalized));
}

function pickNeedMoreSuggestions(currentIngredients = [], desiredCount = 4) {
    const current = new Set(currentIngredients.map((item) => normalizeIngredientName(item)));
    const defaults = [
        "onion",
        "tomato",
        "garlic",
        "ginger",
        "salt",
        "pepper",
        "chili",
        "cumin",
        "turmeric",
        "lemon"
    ];
    const suggestions = defaults.filter((item) => !current.has(normalizeIngredientName(item)));
    return suggestions.slice(0, desiredCount);
}

function buildNeedMoreReply(language, currentIngredients, suggestions) {
    const current = currentIngredients.join(", ");
    const extra = suggestions.join(", ");
    if (normalizeText(language).toLowerCase() === "tamil") {
        return `நீங்கள் கொடுத்த பொருட்கள் மட்டும் வைத்து உறுதியான dish கிடைக்கவில்லை. இன்னும் சில பொருட்கள் சேர்க்கவும்: ${extra}. தற்போது உள்ளவை: ${current}.`;
    }
    return `I could not find a reliable dish using only these ingredients. Please add: ${extra}. Current ingredients: ${current}.`;
}

function normalizeRecipeOutput(recipe = {}, language = "English") {
    const title = normalizeText(recipe.title) || "Chef Special";
    const category = normalizeText(recipe.category) || "World";
    const cuisine = normalizeText(recipe.cuisine) || "Fusion";
    const baseServes = Number(recipe.baseServes);
    const instructionsByLang = recipe.instructionsByLang && typeof recipe.instructionsByLang === "object"
        ? { ...recipe.instructionsByLang }
        : {};
    const instructions = normalizeText(recipe.instructions) ||
        normalizeText(instructionsByLang.English) ||
        normalizeText(instructionsByLang[language]) ||
        "";

    if (instructions && !instructionsByLang.English) {
        instructionsByLang.English = instructions;
    }
    if (instructions && language !== "English" && !instructionsByLang[language]) {
        instructionsByLang[language] = instructions;
    }

    const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
    const normalizedIngredients = ingredients.map((item) => ({
        name: normalizeText(item?.name) || "Ingredient",
        quantity: item?.quantity ?? "",
        unit: normalizeText(item?.unit),
        image: normalizeText(item?.image)
    }));

    return {
        title,
        category,
        cuisine,
        baseServes: Number.isFinite(baseServes) ? baseServes : null,
        ingredients: normalizedIngredients,
        instructions,
        instructionsByLang,
        image: normalizeText(recipe.image) || buildUnsplashImage(title),
        youtube: normalizeText(recipe.youtube),
        source: normalizeText(recipe.source) || "AI"
    };
}

function buildFallbackRecipe(query, language, ingredients = []) {
    const title = normalizeText(query) || "Chef Special";
    const ingredientList = ingredients.length
        ? ingredients
        : ["oil", "onion", "tomato", "salt", "spice mix"];
    const fallbackIngredients = ingredientList.map((item) => ({
        name: item,
        quantity: "",
        unit: ""
    }));
    return normalizeRecipeOutput({
        title,
        category: "World",
        cuisine: "Fusion",
        baseServes: 2,
        ingredients: fallbackIngredients,
        instructions: `1. Prep all ingredients.\n2. Cook on medium heat until aromatic.\n3. Combine and simmer until flavors blend.\n4. Adjust salt and serve hot.`,
        instructionsByLang: language === "English"
            ? { English: `1. Prep all ingredients.\n2. Cook on medium heat until aromatic.\n3. Combine and simmer until flavors blend.\n4. Adjust salt and serve hot.` }
            : { English: `1. Prep all ingredients.\n2. Cook on medium heat until aromatic.\n3. Combine and simmer until flavors blend.\n4. Adjust salt and serve hot.`, [language]: `1. பொருட்களை தயார் செய்யவும்.\n2. நடுத்தர தீயில் வாசனை வரும் வரை சுடவும்.\n3. சேர்த்து மெதுவாக சமைக்கவும்.\n4. உப்பு சரி செய்து பரிமாறவும்.` },
        image: buildUnsplashImage(title),
        source: "Fallback"
    }, language);
}

function buildBasicReply(recipe, language) {
    if (!recipe) {
        return "Here is a recipe suggestion for you.";
    }
    const title = recipe.title || "Recipe";
    const ingredients = (recipe.ingredients || [])
        .map((item) => normalizeText(item?.name))
        .filter(Boolean)
        .slice(0, 12)
        .join(", ");
    const instructions =
        normalizeText(recipe.instructions) ||
        normalizeText(recipe.instructionsByLang?.English) ||
        "";
    const ytLine = `YouTube: ${title} recipe`;

    if (language === "Tamil") {
        return [
            `உணவு: ${title}`,
            `பொருட்கள்: ${ingredients || "கிடைக்கவில்லை"}`,
            `செய்முறை: ${instructions || "சுருக்கமாக தயார் செய்து சமைக்கவும்."}`,
            ytLine
        ].join("\n");
    }

    return [
        `Dish: ${title}`,
        `Ingredients: ${ingredients || "Not listed"}`,
        `Instructions: ${instructions || "Cook following standard steps."}`,
        ytLine
    ].join("\n");
}

async function callOpenAI(promptItems) {
    if (!OPENAI_API_KEY) {
        return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    try {
        const res = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                input: promptItems
            }),
            signal: controller.signal
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(text || "OpenAI error");
        }
        return await res.json();
    } finally {
        clearTimeout(timeout);
    }
}

async function callGroq(promptItems) {
    if (!GROQ_API_KEY) {
        return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
    try {
        const messages = promptItemsToMessages(promptItems);
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages,
                temperature: 0.3
            }),
            signal: controller.signal
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(text || "Groq error");
        }
        return await res.json();
    } finally {
        clearTimeout(timeout);
    }
}

async function callLLMText(promptItems) {
    try {
        if (GROQ_API_KEY) {
            const groq = await callGroq(promptItems);
            return extractGroqText(groq);
        }
        if (OPENAI_API_KEY) {
            const data = await callOpenAI(promptItems);
            return extractResponseText(data);
        }
        return "";
    } catch (err) {
        console.error("LLM call error:", err);
        return "";
    }
}

async function generateAssistantReply({ message, language, recipes }) {
    const primary = recipes[0];
    const title = primary?.title || "";
    const ingredientText = (primary?.ingredients || [])
        .map((item) => normalizeText(item?.name))
        .filter(Boolean)
        .slice(0, 12)
        .join(", ");
    const instructions =
        normalizeText(primary?.instructions) ||
        normalizeText(primary?.instructionsByLang?.[language]) ||
        normalizeText(primary?.instructionsByLang?.English);
    const ytQuery = title ? `${title} recipe` : "recipe";
    const promptItems = [
        {
            role: "system",
            content: [
                {
                    type: "input_text",
                    text:
                        "You are a friendly culinary assistant. Respond in the user's language. " +
                        "Include dish name, ingredients list, and short step-by-step instructions. " +
                        "Add a YouTube suggestion line like: 'YouTube: <dish> recipe'. " +
                        "Return only JSON: {\"reply\":\"...\"}."
                }
            ]
        },
        {
            role: "user",
            content: [
                {
                    type: "input_text",
                    text:
                        `User language: ${language}\n` +
                        `User asked: ${message}\n` +
                        `Dish: ${title}\n` +
                        `Ingredients: ${ingredientText || "none"}\n` +
                        `Instructions: ${instructions || "none"}\n` +
                        `YouTube query: ${ytQuery}`
                }
            ]
        }
    ];

    const text = await callLLMText(promptItems);
    const parsed = safeParseJson(text);
    return normalizeText(parsed?.reply) || "";
}

async function generateRecipesFromOpenAI({ message, language, intent, ingredients }) {
    const ingredientText = normalizeIngredientList(ingredients).join(", ");
    const promptItems = [
        {
            role: "system",
            content: [
                {
                    type: "input_text",
                    text:
                        "You are RecipeGPT. Always reply with valid JSON only, no markdown. " +
                        "Schema: {\"reply\":\"string\",\"recipes\":[{\"title\":\"string\",\"category\":\"string\",\"cuisine\":\"string\",\"baseServes\":number," +
                        "\"ingredients\":[{\"name\":\"string\",\"quantity\":\"string\",\"unit\":\"string\"}],\"instructions\":\"string\",\"instructionsByLang\":object," +
                        "\"image\":\"string\",\"youtubeQuery\":\"string\"}]}.\n" +
                        "Rules: Always return at least 1 recipe. If user asks for ingredients, create dishes that use them. " +
                        "Use user language for reply and add instructionsByLang with English and the user language. " +
                        "If you don't know an image, use https://source.unsplash.com/featured/?<title>."
                }
            ]
        },
        {
            role: "user",
            content: [
                {
                    type: "input_text",
                    text:
                        `User language: ${language}\n` +
                        `Intent: ${intent}\n` +
                        `Ingredients: ${ingredientText || "none"}\n` +
                        `User message: ${message}`
                }
            ]
        }
    ];

    const text = await callLLMText(promptItems);
    const parsed = safeParseJson(text);
    const recipes = Array.isArray(parsed?.recipes) ? parsed.recipes : [];
    const normalizedRecipes = recipes.length
        ? recipes.map((recipe) => normalizeRecipeOutput(recipe, language))
        : [];
    return {
        reply: normalizeText(parsed?.reply),
        recipes: normalizedRecipes
    };
}

async function generateStrictIngredientDishWithLLM({ ingredients, language }) {
    if (!HAS_LLM || !ingredients.length) {
        return {
            status: "need_more",
            reply: "",
            suggestedIngredients: pickNeedMoreSuggestions(ingredients)
        };
    }

    const ingredientText = ingredients.join(", ");
    const promptItems = [
        {
            role: "system",
            content: [
                {
                    type: "input_text",
                    text:
                        "You are a strict ingredient recipe assistant. Return valid JSON only. " +
                        "Schema: {\"status\":\"success|need_more\",\"reply\":\"string\",\"recipe\":{\"title\":\"string\",\"category\":\"string\",\"cuisine\":\"string\",\"baseServes\":number," +
                        "\"ingredients\":[{\"name\":\"string\",\"quantity\":\"string\",\"unit\":\"string\"}],\"instructions\":\"string\",\"instructionsByLang\":object,\"image\":\"string\"}," +
                        "\"suggestedIngredients\":[\"string\"]}. " +
                        "Hard rule: when status is success, recipe ingredients must use ONLY user-provided ingredients. " +
                        "If impossible, set status to need_more and provide 3-5 suggestedIngredients."
                }
            ]
        },
        {
            role: "user",
            content: [
                {
                    type: "input_text",
                    text:
                        `Language: ${language}\n` +
                        `Allowed ingredients only: ${ingredientText}\n` +
                        "Return one practical dish if possible."
                }
            ]
        }
    ];

    const text = await callLLMText(promptItems);
    const parsed = safeParseJson(text);
    if (!parsed || typeof parsed !== "object") {
        return {
            status: "need_more",
            reply: "",
            suggestedIngredients: pickNeedMoreSuggestions(ingredients)
        };
    }

    const status = normalizeText(parsed.status).toLowerCase() === "success" ? "success" : "need_more";
    const suggestedIngredients = sanitizeIngredientInput(parsed.suggestedIngredients || []).slice(0, 5);
    if (status !== "success" || !parsed.recipe) {
        return {
            status: "need_more",
            reply: normalizeText(parsed.reply),
            suggestedIngredients: suggestedIngredients.length
                ? suggestedIngredients
                : pickNeedMoreSuggestions(ingredients)
        };
    }

    const normalizedRecipe = normalizeRecipeOutput(parsed.recipe, language);
    const allowed = ingredients.map((item) => normalizeIngredientName(item));
    normalizedRecipe.ingredients = (normalizedRecipe.ingredients || []).filter((item) =>
        ingredientMatchesProvided(item?.name, allowed)
    );

    if (!normalizedRecipe.ingredients.length) {
        return {
            status: "need_more",
            reply: normalizeText(parsed.reply),
            suggestedIngredients: suggestedIngredients.length
                ? suggestedIngredients
                : pickNeedMoreSuggestions(ingredients)
        };
    }

    if (!normalizedRecipe.instructions) {
        normalizedRecipe.instructions = `1. Prepare ${ingredientText}. 2. Cook in sequence until done. 3. Serve hot.`;
    }

    return {
        status: "success",
        reply: normalizeText(parsed.reply),
        recipe: normalizedRecipe,
        suggestedIngredients: []
    };
}

function mergeRecipeLists(primary = [], secondary = [], limit = 6) {
    const merged = [];
    const seen = new Set();
    [...primary, ...secondary].forEach((recipe) => {
        const key = String(recipe?._id || recipe?.id || recipe?.title || Math.random());
        if (!key || seen.has(key)) {
            return;
        }
        seen.add(key);
        merged.push(recipe);
    });
    return merged.slice(0, limit);
}

function parseRecipeFormData(req) {
    const files = Array.isArray(req.files) ? req.files : [];
    const fileMap = {};
    files.forEach((file) => {
        fileMap[file.fieldname] = file.filename;
    });

    let rawIngredients = [];
    try {
        rawIngredients = JSON.parse(req.body.ingredients || "[]");
    } catch {
        rawIngredients = [];
    }

    const ingredients = Array.isArray(rawIngredients)
        ? rawIngredients
            .map((ingredient) => {
                const imageField = normalizeText(ingredient.imageField);
                const imageFromUpload = imageField && fileMap[imageField] ? fileMap[imageField] : "";
                return {
                    name: normalizeText(ingredient.name),
                    quantity: Number(ingredient.quantity) || 0,
                    unit: normalizeText(ingredient.unit),
                    image: imageFromUpload
                };
            })
            .filter((ingredient) => ingredient.name)
        : [];

    return {
        title: normalizeText(req.body.title),
        category: normalizeText(req.body.category),
        cuisine: normalizeText(req.body.cuisine),
        baseServes: Number(req.body.baseServes) || 1,
        instructions: normalizeText(req.body.instructions),
        youtube: normalizeText(req.body.youtube),
        ingredients,
        image: fileMap.image || "",
        fileMap
    };
}

function buildFallbackAiRecipeReview(recipe) {
    const issues = [];
    const ingredientsCount = Array.isArray(recipe?.ingredients) ? recipe.ingredients.length : 0;
    const instructionLength = normalizeText(recipe?.instructions).length;

    if (ingredientsCount < 2) {
        issues.push("Add at least 2 ingredients with clear quantity and unit.");
    }
    if (instructionLength < 40) {
        issues.push("Instructions are too short. Add clearer cooking steps.");
    }
    if (!normalizeText(recipe?.image)) {
        issues.push("Add a dish image for better approval quality.");
    }

    const score = Math.max(10, 100 - issues.length * 25);
    const decision = score >= 75 ? "approve" : score >= 45 ? "review" : "reject";
    const summary = decision === "approve"
        ? "Recipe looks complete and ready for publishing."
        : decision === "review"
            ? "Recipe needs a quick manual check before publishing."
            : "Recipe quality is low and should be corrected before publish.";

    return {
        decision,
        score,
        summary,
        issues
    };
}

async function evaluateRecipeWithAi(recipe) {
    const fallback = buildFallbackAiRecipeReview(recipe);
    if (!HAS_LLM) {
        return fallback;
    }

    const promptItems = [
        {
            role: "system",
            content: [
                {
                    type: "input_text",
                    text:
                        "You are an admin recipe validator. Return JSON only with schema: " +
                        "{\"decision\":\"approve|review|reject\",\"score\":number,\"summary\":\"string\",\"issues\":[\"string\"]}. " +
                        "Score range 0-100. Reject unsafe/incomplete recipes."
                }
            ]
        },
        {
            role: "user",
            content: [
                {
                    type: "input_text",
                    text: `Recipe data:\n${JSON.stringify({
                        title: recipe?.title,
                        category: recipe?.category,
                        cuisine: recipe?.cuisine,
                        baseServes: recipe?.baseServes,
                        ingredients: recipe?.ingredients,
                        instructions: recipe?.instructions,
                        image: recipe?.image
                    })}`
                }
            ]
        }
    ];

    const text = await callLLMText(promptItems);
    const parsed = safeParseJson(text);
    if (!parsed || typeof parsed !== "object") {
        return fallback;
    }

    return {
        decision: sanitizeAiDecision(parsed.decision),
        score: Math.max(0, Math.min(100, Number(parsed.score) || fallback.score)),
        summary: normalizeText(parsed.summary) || fallback.summary,
        issues: Array.isArray(parsed.issues)
            ? parsed.issues.map((item) => normalizeText(item)).filter(Boolean).slice(0, 8)
            : fallback.issues
    };
}

function normalizeIngredientKey(value) {
    return normalizeText(value).toLowerCase().replace(/\s+/g, "_");
}

function buildIngredientImageUrl(name) {
    const safe = normalizeText(name).replace(/\s+/g, "_");
    if (!safe) {
        return "";
    }
    return `https://www.themealdb.com/images/ingredients/${encodeURIComponent(safe)}.png`;
}

async function fetchMealDb(pathname) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEALDB_TIMEOUT_MS);
    try {
        const res = await fetch(`${MEALDB_BASE}/${pathname}`, { signal: controller.signal });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(text || "MealDB error");
        }
        return await res.json();
    } finally {
        clearTimeout(timeout);
    }
}

function mapMealToRecipe(meal) {
    const ingredients = [];
    for (let i = 1; i <= 20; i += 1) {
        const name = normalizeText(meal[`strIngredient${i}`]);
        const measure = normalizeText(meal[`strMeasure${i}`]);
        if (!name) {
            continue;
        }
        ingredients.push({
            name,
            quantity: measure || "",
            unit: "",
            image: buildIngredientImageUrl(name)
        });
    }

    const instructionsByLang = {};
    if (normalizeText(meal.strInstructions)) {
        instructionsByLang.English = meal.strInstructions;
    }
    if (normalizeText(meal.strInstructionsES)) {
        instructionsByLang.Spanish = meal.strInstructionsES;
    }
    if (normalizeText(meal.strInstructionsDE)) {
        instructionsByLang.German = meal.strInstructionsDE;
    }
    if (normalizeText(meal.strInstructionsFR)) {
        instructionsByLang.French = meal.strInstructionsFR;
    }
    if (normalizeText(meal.strInstructionsIT)) {
        instructionsByLang.Italian = meal.strInstructionsIT;
    }
    if (normalizeText(meal["strInstructionsZH-HANS"])) {
        instructionsByLang["Chinese (Simplified)"] = meal["strInstructionsZH-HANS"];
    }
    if (normalizeText(meal["strInstructionsZH-HANT"])) {
        instructionsByLang["Chinese (Traditional)"] = meal["strInstructionsZH-HANT"];
    }

    return {
        id: meal.idMeal ? `mealdb:${meal.idMeal}` : undefined,
        title: normalizeText(meal.strMeal),
        category: normalizeText(meal.strCategory) || "World",
        cuisine: normalizeText(meal.strArea) || "World",
        baseServes: null,
        instructions: normalizeText(meal.strInstructions),
        instructionsByLang,
        ingredients,
        image: normalizeText(meal.strMealThumb),
        youtube: normalizeText(meal.strYoutube),
        source: "World"
    };
}

async function fetchMealDbFilters() {
    if (isFresh(externalCache.filters, MEALDB_FILTERS_TTL_MS)) {
        return externalCache.filters.data;
    }
    const [categoriesRes, areasRes] = await Promise.all([
        fetchMealDb("list.php?c=list"),
        fetchMealDb("list.php?a=list")
    ]);

    const categories = (categoriesRes?.meals || [])
        .map((item) => normalizeText(item.strCategory))
        .filter(Boolean);
    const areas = (areasRes?.meals || [])
        .map((item) => normalizeText(item.strArea))
        .filter(Boolean);

    const data = { categories, areas };
    externalCache.filters = { data, fetchedAt: Date.now() };
    return data;
}

async function searchMealsByName(query) {
    const normalized = normalizeText(query);
    if (!normalized) {
        return [];
    }

    const cacheKey = normalized.toLowerCase();
    const cached = externalCache.search.get(cacheKey);
    if (isFresh(cached, MEALDB_SEARCH_TTL_MS)) {
        return cached.data;
    }

    const data = await fetchMealDb(`search.php?s=${encodeURIComponent(normalized)}`);
    const meals = (data?.meals || []).map(mapMealToRecipe);
    externalCache.search.set(cacheKey, { data: meals, fetchedAt: Date.now() });
    return meals;
}

async function fetchAllMeals() {
    if (isFresh(externalCache.allMeals, MEALDB_ALL_TTL_MS)) {
        return externalCache.allMeals.data || [];
    }

    const letters = "abcdefghijklmnopqrstuvwxyz".split("");
    const meals = [];
    for (const letter of letters) {
        const data = await fetchMealDb(`search.php?f=${letter}`);
        const batch = (data?.meals || []).map(mapMealToRecipe);
        meals.push(...batch);
    }

    externalCache.allMeals = { data: meals, fetchedAt: Date.now() };
    return meals;
}

async function fetchMealsByIngredients(ingredients, limit = 12) {
    const clean = ingredients
        .map((item) => normalizeText(item))
        .filter(Boolean);
    if (!clean.length) {
        return [];
    }

    const cacheKey = clean.map((item) => item.toLowerCase()).sort().join(",");
    const cached = externalCache.ingredients.get(cacheKey);
    if (isFresh(cached, MEALDB_SEARCH_TTL_MS)) {
        return cached.data;
    }

    const lists = await Promise.all(
        clean.map((item) => fetchMealDb(`filter.php?i=${encodeURIComponent(normalizeIngredientKey(item))}`))
    );

    const idSets = lists.map((data) => new Set((data?.meals || []).map((meal) => meal.idMeal)));
    if (!idSets.length || idSets.some((set) => set.size === 0)) {
        externalCache.ingredients.set(cacheKey, { data: [], fetchedAt: Date.now() });
        return [];
    }

    let intersection = idSets[0];
    for (let i = 1; i < idSets.length; i += 1) {
        intersection = new Set([...intersection].filter((id) => idSets[i].has(id)));
    }

    const ids = [...intersection].slice(0, limit);
    const details = await Promise.all(ids.map((id) => fetchMealDb(`lookup.php?i=${id}`)));
    const meals = details
        .flatMap((detail) => detail?.meals || [])
        .map(mapMealToRecipe);

    externalCache.ingredients.set(cacheKey, { data: meals, fetchedAt: Date.now() });
    return meals;
}


mongoose.connect('mongodb://localhost:27017/recipe_finder', {
})
    .then(() => {
        console.log('connected to database');
        expirePremiumAccessForAllUsers().catch((err) => {
            console.error("Initial premium expiry sweep error:", err);
        });
        setInterval(() => {
            expirePremiumAccessForAllUsers().catch((err) => {
                console.error("Premium expiry sweep error:", err);
            });
        }, PREMIUM_EXPIRY_SWEEP_MS);
        app.listen(port, host, () => {
            const launchUrl = APP_BASE_URL || `http://localhost:${port}`;
            console.log(`server is running on ${host}:${port}`);
            console.log(`local: http://localhost:${port}`);
            if (APP_BASE_URL) {
                console.log(`app base url: ${APP_BASE_URL}`);
            }
            console.log(`URL: ${launchUrl}`);
        });
    })
    .catch((err) => {
        console.error('error connecting to database', err);
        
    });

app.use(express.static(__dirname + '/front_end'));


app.get('/',(req,res)=>{
    res.sendFile(path.join(__dirname,'./front_end/landing.html'))
});

app.get('/login',(req,res)=>{
    res.sendFile(path.join(__dirname,'./front_end/login.html'))
});

app.get('/forgot-password',(req,res)=>{
    res.sendFile(path.join(__dirname,'./front_end/forgot_password.html'))
});

app.get('/recipes',(req,res)=>{
    res.sendFile(path.join(__dirname,'./front_end/normal_recipes.html'))
});

app.get('/normal-search',(req,res)=>{
    res.sendFile(path.join(__dirname,'./front_end/normal_recipes.html'))
});

app.get('/premium-search',(req,res)=>{
    res.sendFile(path.join(__dirname,'./front_end/premium_search.html'))
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        if (!email || !password) {
            return res.status(400).json({
                message: "Email and password required"
            });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const user = await User.findOne({ email: normalizedEmail });

        if (!user) {
            return res.status(400).json({
                message: "User not found"
            });
        }

        if (user.password !== password) {
            return res.status(400).json({
                message: "Invalid password"
            });
        }

        await expirePremiumAccessIfNeeded(user);
        const premiumSnapshot = buildPremiumSnapshot(user);

        if (isAdminEmail(normalizedEmail)) {
            return res.status(200).json({
                message: "Admin login successful",
                redirect: "/admin",
                language: "English",
                email: user.email,
                name: user.name,
                ...premiumSnapshot,
                role: "admin"
            });
        }

        const redirect = "/user";
        const loginMessage = premiumSnapshot.premiumPendingApproval
            ? "Payment verified. Waiting for admin approval."
            : "Login successful";

        return res.status(200).json({
            message: loginMessage,
            redirect,
            language: user.language || "English",
            email: user.email,
            name: user.name,
            ...premiumSnapshot,
            role: "user"
        });
    } catch (err) {
        console.error("Login error:", err);
        return res.status(500).json({
            message: "Server error"
        });
    }
});
app.get('/register',(req,res)=>{
    res.sendFile(path.join(__dirname,'./front_end/register.html'))
});

app.post('/register',async(req,res)=>{
    const {name,email,password,language}=req.body;
    try{
        if(!name||!email||!password){
            return res.status(400).json({message:"all fields are required please fill all of them"})
        }
        if (!isOtpMailConfigured()) {
            return res.status(500).json({
                message: "Email service is not configured",
                hint: getOtpConfigHint()
            });
        }
        const normalizedName = name.trim();
        const normalizedEmail = email.trim().toLowerCase();
        const normalizedLanguage = (language || "English").trim();
         
        const userExists=await User.findOne({email: normalizedEmail});
        if(userExists && isUserEmailVerified(userExists)){
            return res.status(400).json({message:"user already exists"})
        }
        if (userExists && !isUserEmailVerified(userExists)) {
            userExists.name = normalizedName || userExists.name;
            userExists.password = password;
            userExists.language = normalizedLanguage || userExists.language || "English";
            const verificationMeta = await issueEmailVerificationMail(userExists, req);
            return res.status(200).json({
                message: "Account exists but email is not verified. Verification mail sent again.",
                requiresEmailVerification: true,
                email: normalizedEmail,
                ...verificationMeta
            });
        }
         
        const user =new User({
            name: normalizedName,
            email: normalizedEmail,
            password,
            language: normalizedLanguage,
            emailVerified: false
        })
         
        await user.save()
        const verificationMeta = await issueEmailVerificationMail(user, req);
        return res.status(201).json({
            message:"Registration successful. Verification mail sent to your email.",
            requiresEmailVerification: true,
            email: normalizedEmail,
            ...verificationMeta
        })
    }
    catch(err){
            console.error("Registration error:", err);
            return res.status(500).json({
                message: "Failed to register user",
                hint: getMailErrorHint(err)
            });

        }
    
})

const handleEmailVerificationRequest = async (req, res) => {
    try {
        const email = normalizeText(req.body.email).toLowerCase();
        if (!email) {
            return res.status(400).json({ message: "Email is required." });
        }
        if (!isOtpMailConfigured()) {
            return res.status(500).json({
                message: "Email service is not configured",
                hint: getOtpConfigHint()
            });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }
        if (isUserEmailVerified(user)) {
            return res.status(400).json({ message: "Email is already verified." });
        }

        const verificationMeta = await issueEmailVerificationMail(user, req);
        return res.status(200).json({
            message: "Verification mail sent.",
            email,
            ...verificationMeta
        });
    } catch (err) {
        console.error("Email verification request error:", err);
        return res.status(500).json({
            message: "Failed to send verification mail",
            hint: getMailErrorHint(err)
        });
    }
};

app.post("/api/auth/email-verification/request", handleEmailVerificationRequest);
app.post("/api/auth/email-verification/resend", handleEmailVerificationRequest);

app.get("/api/auth/email-verification/confirm", async (req, res) => {
    try {
        const email = normalizeText(req.query.email).toLowerCase();
        const token = normalizeText(req.query.token);
        if (!email || !token) {
            return res.status(400).send("Invalid verification link.");
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).send("User not found.");
        }
        if (isUserEmailVerified(user)) {
            return res.status(200).send(`
                <h2>Email already verified.</h2>
                <p>Your account is active.</p>
                <p><a href="/login">Go to Login</a></p>
            `);
        }
        if (!normalizeText(user.emailVerificationToken)) {
            return res.status(400).send("Verification token not found. Please request verification email again.");
        }
        if (Date.now() > Number(user.emailVerificationTokenExpiresAt || 0)) {
            clearEmailVerificationToken(user);
            await user.save();
            return res.status(400).send("Verification link expired. Please request a new verification email.");
        }
        if (user.emailVerificationToken !== token) {
            return res.status(400).send("Invalid verification token.");
        }

        user.emailVerified = true;
        clearEmailVerificationToken(user);
        await user.save();

        return res.status(200).send(`
            <h2>Email verified successfully.</h2>
            <p>Your account is now active.</p>
            <p><a href="/login">Login now</a></p>
        `);
    } catch (err) {
        console.error("Email verification error:", err);
        return res.status(500).send("Failed to verify email.");
    }
});

app.post("/api/auth/forgot-password/request", async (req, res) => {
    try {
        const email = normalizeText(req.body.email).toLowerCase();
        if (!email) {
            return res.status(400).json({ message: "Email is required." });
        }
        if (!isOtpMailConfigured()) {
            return res.status(500).json({
                message: "OTP email service is not configured",
                hint: getOtpConfigHint()
            });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }

        cleanupExpiredPasswordResetOtps();
        const otp = generatePaymentOtp();
        passwordResetOtps.set(email, {
            otp,
            expiresAt: Date.now() + PASSWORD_RESET_OTP_TTL_MS
        });

        const payload = buildPasswordResetOtpPayload({ otp });
        await sendTransactionalEmail({
            to: email,
            subject: payload.subject,
            text: payload.text,
            html: payload.html
        });

        res.status(200).json({
            message: "OTP sent to your registered email.",
            otpSentTo: maskEmail(email),
            expiresInSeconds: Math.floor(PASSWORD_RESET_OTP_TTL_MS / 1000)
        });
    } catch (err) {
        console.error("Forgot password OTP request error:", err);
        res.status(500).json({
            message: "Failed to send OTP email",
            hint: getMailErrorHint(err)
        });
    }
});

app.post("/api/auth/forgot-password/resend", async (req, res) => {
    try {
        const email = normalizeText(req.body.email).toLowerCase();
        if (!email) {
            return res.status(400).json({ message: "Email is required." });
        }
        if (!isOtpMailConfigured()) {
            return res.status(500).json({
                message: "OTP email service is not configured",
                hint: getOtpConfigHint()
            });
        }
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }

        const otp = generatePaymentOtp();
        passwordResetOtps.set(email, {
            otp,
            expiresAt: Date.now() + PASSWORD_RESET_OTP_TTL_MS
        });

        const payload = buildPasswordResetOtpPayload({ otp });
        await sendTransactionalEmail({
            to: email,
            subject: payload.subject,
            text: payload.text,
            html: payload.html
        });

        res.status(200).json({
            message: "OTP resent to your registered email.",
            otpSentTo: maskEmail(email),
            expiresInSeconds: Math.floor(PASSWORD_RESET_OTP_TTL_MS / 1000)
        });
    } catch (err) {
        console.error("Forgot password OTP resend error:", err);
        res.status(500).json({
            message: "Failed to resend OTP email",
            hint: getMailErrorHint(err)
        });
    }
});

app.post("/api/auth/forgot-password/reset", async (req, res) => {
    try {
        const email = normalizeText(req.body.email).toLowerCase();
        const otp = normalizeText(req.body.otp);
        const newPassword = normalizeText(req.body.newPassword);
        if (!email || !otp || !newPassword) {
            return res.status(400).json({ message: "Email, OTP, and new password are required." });
        }

        cleanupExpiredPasswordResetOtps();
        const entry = passwordResetOtps.get(email);
        if (!entry) {
            return res.status(400).json({ message: "OTP not found or expired. Please request again." });
        }
        if (Date.now() > Number(entry.expiresAt || 0)) {
            passwordResetOtps.delete(email);
            return res.status(400).json({ message: "OTP expired. Please request again." });
        }
        if (entry.otp !== otp) {
            return res.status(400).json({ message: "Invalid OTP." });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }

        user.password = newPassword;
        await user.save();
        passwordResetOtps.delete(email);

        res.status(200).json({ message: "Password reset successful." });
    } catch (err) {
        console.error("Forgot password reset error:", err);
        res.status(500).json({ message: "Failed to reset password." });
    }
});

app.post("/admin/add-recipe", upload.any(), async (req, res) => {
    try {
        const recipeData = parseRecipeFormData(req);
        if (!recipeData.title || !recipeData.category || !recipeData.cuisine || !recipeData.instructions) {
            return res.status(400).json({ message: "Title, category, cuisine, and instructions are required." });
        }

        const submittedByEmail = normalizeText(req.body.submittedByEmail).toLowerCase() || ADMIN_EMAIL;
        const submittedByName = normalizeText(req.body.submittedByName) || "Admin";
        const newRecipe = new Recipe({
            ...recipeData,
            status: "approved",
            submittedByRole: "admin",
            submittedByEmail,
            submittedByName,
            verificationMode: "admin",
            verifiedAt: new Date(),
            verifiedBy: submittedByEmail
        });

        await newRecipe.save();
        res.status(201).json({ message: "Recipe added successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Error adding recipe" });
    }
});

app.post("/user/add-recipe", upload.any(), async (req, res) => {
    try {
        const recipeData = parseRecipeFormData(req);
        if (!recipeData.title || !recipeData.category || !recipeData.cuisine || !recipeData.instructions) {
            return res.status(400).json({ message: "Title, category, cuisine, and instructions are required." });
        }

        const submittedByEmail = normalizeText(req.body.submittedByEmail).toLowerCase();
        const submittedByName = normalizeText(req.body.submittedByName) || "User";
        if (!submittedByEmail) {
            return res.status(400).json({ message: "Submitted user email is required." });
        }

        const user = await User.findOne({ email: submittedByEmail }).lean();
        if (!user) {
            return res.status(404).json({ message: "User not found for submission email." });
        }

        // User submission is staged in a separate collection.
        const pendingRecipe = new PendingRecipe({
            ...recipeData,
            status: "pending",
            submittedByRole: "user",
            submittedByEmail,
            submittedByName
        });

        await pendingRecipe.save();
        res.status(201).json({
            message: "Recipe submitted for admin review. It will be stored in recipes only after approval.",
            status: "pending"
        });
    } catch (err) {
        console.error("User recipe submit error:", err);
        res.status(500).json({ message: "Failed to submit recipe." });
    }
});

app.get("/user/submitted-recipes", async (req, res) => {
    try {
        const email = normalizeText(req.query.email).toLowerCase();
        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }

        const [pendingRecipes, approvedOrHistorical] = await Promise.all([
            PendingRecipe.find({ submittedByEmail: email }).sort({ createdAt: -1 }).lean(),
            Recipe.find({
                submittedByEmail: email,
                submittedByRole: "user",
                status: "approved"
            }).sort({ createdAt: -1 }).lean()
        ]);

        const merged = [...pendingRecipes, ...approvedOrHistorical]
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        const mapped = merged.map((recipe) => ({
            ...recipe,
            statusMessage: buildUserSubmissionStatusMessage(recipe)
        }));
        res.status(200).json({ recipes: mapped });
    } catch (err) {
        console.error("User submitted recipe fetch error:", err);
        res.status(500).json({ message: "Failed to fetch user submission status" });
    }
});

// Admin Route
app.get('/admin', (req, res) => {
     res.sendFile(path.join(__dirname, 'front_end/admin.html'));
});

// User Route
app.get('/user', (req, res) => {
     res.sendFile(path.join(__dirname, 'front_end/home.html'));
});

app.get('/user/add-recipe', (req, res) => {
     res.sendFile(path.join(__dirname, 'front_end/user_add_recipe.html'));
});

app.get('/chefs', (req, res) => {
     res.sendFile(path.join(__dirname, 'front_end/chefs.html'));
});

app.get('/contact', (req, res) => {
     res.sendFile(path.join(__dirname, 'front_end/contact.html'));
});

app.get('/premium', (req, res) => {
     res.sendFile(path.join(__dirname, 'front_end/premium.html'));
});

app.get('/premium/access', (req, res) => {
     res.sendFile(path.join(__dirname, 'front_end/premium_access.html'));
});

app.get('/watch', (req, res) => {
     res.sendFile(path.join(__dirname, 'front_end/watch.html'));
});

app.get('/admin/dashboard-data', async (req, res) => {
    try {
        await expirePremiumAccessForAllUsers();

        const totalUsers = await User.countDocuments();
        const totalRecipes = await Recipe.countDocuments({ status: { $ne: "rejected" } });
        const totalApprovedRecipes = await Recipe.countDocuments({ status: "approved" });
        const totalPendingRecipes = await PendingRecipe.countDocuments();
        const totalRejectedRecipes = await Recipe.countDocuments({ status: "rejected" });
        const totalPremiumUsers = await User.countDocuments({ premium: true });

        const breakfast = await Recipe.countDocuments({ category: /^Breakfast$/i, status: "approved" });
        const lunch = await Recipe.countDocuments({ category: /^Lunch$/i, status: "approved" });
        const dinner = await Recipe.countDocuments({ category: /^Dinner$/i, status: "approved" });

        const recentRecipes = await Recipe.find()
            .sort({ createdAt: -1 })
            .limit(5)
            .lean();
        const recentPendingRecipes = await PendingRecipe.find({})
            .sort({ createdAt: -1 })
            .limit(8)
            .lean();

        res.json({
            totalUsers,
            totalRecipes,
            totalApprovedRecipes,
            totalPendingRecipes,
            totalRejectedRecipes,
            totalPremiumUsers,
            categories: {
                breakfast,
                lunch,
                dinner
            },
            recentRecipes,
            recentPendingRecipes
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
});

app.get("/admin/add_recipe",(req,res)=>{
     res.sendFile(path.join(__dirname, 'front_end/add_recipe.html'));
});

app.get("/user/recipes", async (req, res) => {
    try {
        const recipes = await Recipe.find({ status: "approved" }).sort({ createdAt: -1 });
        res.json(recipes);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.get("/api/recipes", async (req, res) => {
    try {
        const all = parseBoolean(req.query.all);
        const includePending = parseBoolean(req.query.includePending);
        let filter = { status: "approved" };
        if (all) {
            filter = {};
        } else if (includePending) {
            filter = { status: { $in: ["approved", "pending"] } };
        }

        const recipes = await Recipe.find(filter).sort({ createdAt: -1 }).lean();
        res.status(200).json(recipes);
    } catch (err) {
        console.error("Error fetching recipes:", err);
        res.status(500).json({ message: "Failed to fetch recipes" });
    }
});

app.get("/admin/users", async (req, res) => {
    try {
        await expirePremiumAccessForAllUsers();
        const users = await User.find()
            .sort({ createdAt: -1 })
            .select("-password")
            .lean();
        const mappedUsers = users.map((user) => ({
            ...user,
            isAdmin: isAdminEmail(user?.email),
            ...buildPremiumSnapshot(user)
        }));
        res.status(200).json(mappedUsers);
    } catch (err) {
        console.error("Admin users fetch error:", err);
        res.status(500).json({ message: "Failed to fetch users" });
    }
});

app.get("/admin/premium-settings", async (req, res) => {
    try {
        const settings = await getPremiumPlansConfig();
        res.status(200).json(settings);
    } catch (err) {
        console.error("Premium settings fetch error:", err);
        res.status(500).json({ message: "Failed to fetch premium settings" });
    }
});

app.put("/admin/premium-settings", async (req, res) => {
    try {
        const adminEmail = normalizeText(req.body.adminEmail).toLowerCase();
        if (!isAdminEmail(adminEmail)) {
            return res.status(403).json({ message: "Only admin can update premium settings." });
        }

        const planPayload = req.body.plans;
        if (!Array.isArray(planPayload)) {
            return res.status(400).json({ message: "Plans array is required." });
        }

        const updated = await savePremiumPlansConfig({
            plans: planPayload,
            defaultPlanId: req.body.defaultPlanId
        });
        res.status(200).json({
            message: "Premium settings updated successfully.",
            settings: updated
        });
    } catch (err) {
        console.error("Premium settings update error:", err);
        if (String(err?.message || "").includes("At least one premium plan is required.")) {
            return res.status(400).json({ message: "At least one premium plan is required." });
        }
        if (String(err?.message || "").includes("Failed to sanitize premium plans")) {
            return res.status(400).json({ message: "Invalid premium plan payload." });
        }
        res.status(500).json({ message: "Failed to update premium settings" });
    }
});

app.get("/api/premium/settings", async (req, res) => {
    try {
        const settings = await getPremiumPlansConfig();
        const email = normalizeText(req.query.email).toLowerCase();
        let filteredPlans = Array.isArray(settings.plans) ? settings.plans : [];
        if (email) {
            const user = await User.findOne({ email }).select("usedOneTimePlanIds").lean();
            if (user) {
                filteredPlans = filterPlansForUser(filteredPlans, user);
            }
        }
        const resolvedDefaultPlanId = filteredPlans.some((plan) => String(plan.id) === String(settings.defaultPlanId))
            ? settings.defaultPlanId
            : (filteredPlans[0] ? filteredPlans[0].id : "");
        const defaultPlan = findPremiumPlanById(filteredPlans, resolvedDefaultPlanId);
        res.status(200).json({
            ...settings,
            plans: filteredPlans,
            defaultPlanId: resolvedDefaultPlanId,
            id: defaultPlan?.id || "",
            amount: defaultPlan?.amount || 0,
            currency: defaultPlan?.currency || "",
            name: defaultPlan?.name || "",
            durationDays: defaultPlan?.durationDays || 0
        });
    } catch (err) {
        console.error("Public premium settings fetch error:", err);
        res.status(500).json({ message: "Failed to fetch premium settings" });
    }
});

app.get("/api/user/premium-status", async (req, res) => {
    try {
        const email = normalizeText(req.query.email).toLowerCase();
        if (!email) {
            return res.status(400).json({ message: "Email is required." });
        }
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }
        await expirePremiumAccessIfNeeded(user);
        const snapshot = buildPremiumSnapshot(user);
        res.status(200).json(snapshot);
    } catch (err) {
        console.error("Premium status fetch error:", err);
        res.status(500).json({ message: "Failed to fetch premium status" });
    }
});

// Get saved meal plan for a user
app.get("/api/user/mealplan", async (req, res) => {
    try {
        const email = normalizeText(req.query.email).toLowerCase();
        if (!email) {
            return res.status(400).json({ message: "Email is required." });
        }
        const user = await User.findOne({ email }).lean();
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }
        return res.status(200).json({ mealPlan: user.mealPlan || [] });
    } catch (err) {
        console.error("Fetch meal plan error:", err);
        res.status(500).json({ message: "Failed to fetch meal plan" });
    }
});

// Save meal plan for a user (replaces existing plan)
app.post("/api/user/mealplan", async (req, res) => {
    try {
        const email = normalizeText(req.body.email).toLowerCase();
        const plan = Array.isArray(req.body.plan) ? req.body.plan : [];
        if (!email) {
            return res.status(400).json({ message: "Email is required." });
        }
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }
        user.mealPlan = plan;
        await user.save();
        return res.status(200).json({ message: "Meal plan saved." });
    } catch (err) {
        console.error("Save meal plan error:", err);
        res.status(500).json({ message: "Failed to save meal plan" });
    }
});

// Generate grocery list from a user's saved plan or provided plan
app.post("/api/user/grocery-list", async (req, res) => {
    try {
        const email = normalizeText(req.body.email).toLowerCase();
        const scope = normalizeText(req.body.scope) || "week"; // 'day' or 'week'
        const day = normalizeText(req.body.day) || "";
        const providedPlan = Array.isArray(req.body.plan) ? req.body.plan : null;

        let plan = providedPlan;
        if (!plan) {
            if (!email) {
                return res.status(400).json({ message: "Email or plan is required." });
            }
            const user = await User.findOne({ email }).lean();
            if (!user) {
                return res.status(404).json({ message: "User not found." });
            }
            plan = user.mealPlan || [];
        }

        const filtered = scope === "day" && day ? plan.filter((p) => normalizeText(p.day) === normalizeText(day)) : plan;

        function parseQuantityText(raw) {
            if (raw === undefined || raw === null) return NaN;
            const text = String(raw).trim();
            if (text.includes("/")) {
                const parts = text.split("/");
                if (parts.length === 2) {
                    const num = Number(parts[0]);
                    const den = Number(parts[1]);
                    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
                        return num / den;
                    }
                }
                return NaN;
            }
            const value = Number(text);
            return Number.isFinite(value) ? value : NaN;
        }

        function formatQuantity(value) {
            if (!Number.isFinite(value)) return "";
            const rounded = Math.round(value * 100) / 100;
            if (Number.isInteger(rounded)) return String(rounded);
            return String(rounded).replace(/\.?0+$/, "");
        }

        const map = new Map();
        for (const entry of filtered) {
            const recipe = entry.recipe || {};
            const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
            const baseServes = Number(recipe.baseServes) || 0;
            const desiredServes = Number(entry.serves) || baseServes || 1;
            const factor = baseServes > 0 ? desiredServes / baseServes : 1;
            for (const item of ingredients) {
                const name = (item.name || "").trim();
                if (!name) continue;
                const unit = (item.unit || "").trim();
                const qty = parseQuantityText(item.quantity);
                const key = `${name.toLowerCase()}|${unit.toLowerCase()}`;
                if (!map.has(key)) map.set(key, { name, unit, qty: 0, hasQty: false });
                const data = map.get(key);
                if (Number.isFinite(qty)) {
                    data.qty += qty * factor;
                    data.hasQty = true;
                }
            }
        }

        const lines = Array.from(map.values()).map((item) => {
            if (item.hasQty) {
                return `${item.name} - ${formatQuantity(item.qty)} ${item.unit}`.trim();
            }
            return item.unit ? `${item.name} - ${item.unit}` : item.name;
        });

        return res.status(200).json({ grocery: lines.length ? lines : ["No items yet."] });
    } catch (err) {
        console.error("Grocery list generation error:", err);
        res.status(500).json({ message: "Failed to generate grocery list" });
    }
});

app.put("/admin/users/:id/premium", async (req, res) => {
    try {
        const premium = parseBoolean(req.body.premium);
        const verifiedBy = normalizeText(req.body.verifiedBy).toLowerCase() || ADMIN_EMAIL;
        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        await expirePremiumAccessIfNeeded(user);

        if (premium) {
            const { plans, defaultPlanId } = await getPremiumPlansConfig();
            const chosenPlan = findPremiumPlanById(plans, user.premiumPlanId || defaultPlanId);
            if (!chosenPlan) {
                return res.status(400).json({ message: "No premium plans configured. Please add plans in admin settings." });
            }
            const chosenPlanId = normalizePlanId(chosenPlan.id);
            const usedOneTimePlanIds = getUsedOneTimePlanIdSet(user);
            if (chosenPlan.oneTimePerUser && chosenPlanId && usedOneTimePlanIds.has(chosenPlanId)) {
                return res.status(400).json({ message: "This test plan is already used once by this user." });
            }
            const durationHoursOverride = Number(req.body.durationHours);
            const hasHourOverride = Number.isFinite(durationHoursOverride) && durationHoursOverride > 0;
            const durationDaysOverride = Number(req.body.durationDays);
            const hasDayOverride = Number.isFinite(durationDaysOverride) && durationDaysOverride > 0;
            const durationDays = hasHourOverride
                ? sanitizePremiumDurationDays(durationHoursOverride / 24, user.premiumDurationDays || chosenPlan.durationDays)
                : hasDayOverride
                    ? sanitizePremiumDurationDays(durationDaysOverride, user.premiumDurationDays || chosenPlan.durationDays)
                    : sanitizePremiumDurationDays(
                        user.premiumDurationDays || chosenPlan.durationDays,
                        chosenPlan.durationDays
                    );
            const now = new Date();
            const expiresAt = addDays(now, durationDays);

            user.premium = true;
            user.premiumStatus = PREMIUM_STATUS.ACTIVE;
            user.premiumActivatedAt = now;
            user.premiumExpiresAt = expiresAt;
            user.premiumRequestedAt = null;
            user.premiumPlanId = chosenPlan.id;
            user.premiumPlanName = chosenPlan.name;
            user.premiumDurationDays = durationDays;
            user.premiumAmount = chosenPlan.amount;
            user.premiumCurrency = chosenPlan.currency;
            if (chosenPlan.oneTimePerUser && chosenPlanId) {
                user.usedOneTimePlanIds = Array.from(new Set([
                    ...(Array.isArray(user.usedOneTimePlanIds) ? user.usedOneTimePlanIds : []),
                    chosenPlanId
                ]));
            }
            user.premiumGrantedBy = verifiedBy;
            user.premiumRevokedAt = null;
            user.premiumRevokedBy = "";
        } else {
            user.premium = false;
            user.premiumStatus = PREMIUM_STATUS.REVOKED;
            user.premiumActivatedAt = null;
            user.premiumExpiresAt = null;
            user.premiumRequestedAt = null;
            user.premiumRevokedAt = new Date();
            user.premiumRevokedBy = verifiedBy;
        }

        await user.save();

        const output = {
            ...user.toObject(),
            ...buildPremiumSnapshot(user)
        };
        delete output.password;
        res.status(200).json({ message: "Premium status updated", user: output });
    } catch (err) {
        console.error("Premium update error:", err);
        res.status(500).json({ message: "Failed to update premium status" });
    }
});

app.delete("/admin/users/:id", async (req, res) => {
    try {
        const adminEmail = normalizeText(req.body.adminEmail).toLowerCase();
        if (!isAdminEmail(adminEmail)) {
            return res.status(403).json({ message: "Only admin can delete users." });
        }

        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }

        const targetEmail = normalizeText(user.email).toLowerCase();
        if (isAdminEmail(targetEmail)) {
            return res.status(400).json({ message: "Admin account cannot be deleted." });
        }

        await User.deleteOne({ _id: user._id });
        passwordResetOtps.delete(targetEmail);

        res.status(200).json({
            message: "User deleted successfully.",
            deletedUserId: String(user._id),
            deletedEmail: targetEmail
        });
    } catch (err) {
        console.error("Admin user delete error:", err);
        res.status(500).json({ message: "Failed to delete user." });
    }
});

app.get("/admin/submitted-recipes", async (req, res) => {
    try {
        const requestedStatus = normalizeText(req.query.status).toLowerCase();
        if (requestedStatus && requestedStatus !== "pending") {
            return res.status(200).json([]);
        }
        const filter =
            requestedStatus === "pending"
                ? { status: "pending" }
                : {};
        const recipes = await PendingRecipe.find(filter).sort({ createdAt: -1 }).lean();
        res.status(200).json(recipes);
    } catch (err) {
        console.error("Submitted recipes fetch error:", err);
        res.status(500).json({ message: "Failed to fetch submitted recipes" });
    }
});

app.post("/admin/submitted-recipes/:id/ai-review", async (req, res) => {
    try {
        const recipe = await PendingRecipe.findById(req.params.id);
        if (!recipe) {
            return res.status(404).json({ message: "Recipe not found" });
        }
        const aiReview = await evaluateRecipeWithAi(recipe.toObject());
        recipe.aiReview = {
            decision: aiReview.decision,
            score: aiReview.score,
            summary: aiReview.summary,
            issues: aiReview.issues,
            checkedAt: new Date()
        };
        recipe.verificationMode = "ai";
        await recipe.save();
        res.status(200).json({ message: "AI review completed", aiReview: recipe.aiReview });
    } catch (err) {
        console.error("AI review error:", err);
        res.status(500).json({ message: "Failed to run AI review" });
    }
});

app.post("/admin/submitted-recipes/:id/decision", async (req, res) => {
    try {
        const status = sanitizeRecipeStatus(req.body.status, "pending");
        if (status !== "approved" && status !== "rejected") {
            return res.status(400).json({ message: "Status must be approved or rejected." });
        }
        const pendingRecipe = await PendingRecipe.findById(req.params.id);
        if (!pendingRecipe) {
            return res.status(404).json({ message: "Recipe not found" });
        }
        const verificationNote = buildVerificationNote({
            status,
            manualNote: req.body.note,
            recipe: pendingRecipe
        });
        const verifiedBy = normalizeText(req.body.verifiedBy).toLowerCase() || ADMIN_EMAIL;

        let approvedRecipe = null;
        if (status === "approved") {
            approvedRecipe = await Recipe.create({
                title: pendingRecipe.title,
                category: pendingRecipe.category,
                cuisine: pendingRecipe.cuisine,
                baseServes: pendingRecipe.baseServes,
                ingredients: pendingRecipe.ingredients,
                instructions: pendingRecipe.instructions,
                image: pendingRecipe.image,
                youtube: pendingRecipe.youtube,
                status: "approved",
                submittedByRole: "user",
                submittedByEmail: pendingRecipe.submittedByEmail,
                submittedByName: pendingRecipe.submittedByName,
                verificationMode: "admin",
                verificationNote,
                verifiedBy,
                verifiedAt: new Date(),
                aiReview: pendingRecipe.aiReview
            });
        }

        await PendingRecipe.findByIdAndDelete(pendingRecipe._id);

        if (pendingRecipe.submittedByEmail && isOtpMailConfigured()) {
            const payload = buildRecipeDecisionMailPayload({
                recipeTitle: pendingRecipe.title || "Recipe",
                status,
                note: verificationNote
            });
            try {
                await sendTransactionalEmail({
                    to: pendingRecipe.submittedByEmail,
                    subject: payload.subject,
                    text: payload.text,
                    html: payload.html
                });
            } catch (mailErr) {
                console.error("Recipe decision mail error:", mailErr);
            }
        }

        res.status(200).json({
            message: status === "approved"
                ? "Recipe approved and stored in recipe database."
                : "Recipe rejected and removed from pending submissions.",
            recipe: approvedRecipe
        });
    } catch (err) {
        console.error("Recipe decision error:", err);
        res.status(500).json({ message: "Failed to update recipe status" });
    }
});

app.post("/admin/notifications/send", async (req, res) => {
    try {
        const subject = normalizeText(req.body.subject);
        const message = normalizeText(req.body.message);
        if (!subject || !message) {
            return res.status(400).json({ message: "Subject and message are required." });
        }
        if (!isOtpMailConfigured()) {
            return res.status(500).json({
                message: "Email service is not configured",
                hint: getOtpConfigHint()
            });
        }

        const users = await User.find({}, { email: 1, _id: 0 }).lean();
        const uniqueEmails = Array.from(
            new Set(users.map((item) => normalizeText(item.email).toLowerCase()).filter(Boolean))
        );
        if (!uniqueEmails.length) {
            return res.status(404).json({ message: "No registered users found." });
        }

        const payload = buildAdminBroadcastPayload({ subject, message });
        const results = await Promise.allSettled(
            uniqueEmails.map((email) => sendTransactionalEmail({
                to: email,
                subject: payload.subject,
                text: payload.text,
                html: payload.html
            }))
        );
        const sent = results.filter((item) => item.status === "fulfilled").length;
        const failed = results.length - sent;

        res.status(200).json({
            message: "Admin notification processed.",
            sent,
            failed,
            totalRecipients: uniqueEmails.length
        });
    } catch (err) {
        console.error("Admin notification error:", err);
        res.status(500).json({ message: "Failed to send admin notification." });
    }
});

app.post("/api/contact-admin", async (req, res) => {
    try {
        const name = normalizeText(req.body.name);
        const email = normalizeText(req.body.email).toLowerCase();
        const message = normalizeText(req.body.message);
        if (!name || !email || !message) {
            return res.status(400).json({ message: "Name, email, and message are required." });
        }
        if (!isOtpMailConfigured()) {
            return res.status(500).json({
                message: "Email service is not configured",
                hint: getOtpConfigHint()
            });
        }

        const payload = buildAdminContactPayload({
            fromName: name,
            fromEmail: email,
            message
        });
        await sendTransactionalEmail({
            to: ADMIN_CONTACT_EMAIL,
            subject: payload.subject,
            text: payload.text,
            html: payload.html
        });

        res.status(200).json({ message: "Message sent to admin." });
    } catch (err) {
        console.error("Contact admin error:", err);
        res.status(500).json({ message: "Failed to send message to admin." });
    }
});

app.get("/api/external/filters", async (req, res) => {
    try {
        const data = await fetchMealDbFilters();
        res.status(200).json(data);
    } catch (err) {
        console.error("Error fetching external filters:", err);
        res.status(500).json({ message: "Failed to fetch external filters" });
    }
});

app.get("/api/external/search", async (req, res) => {
    try {
        const query = normalizeText(req.query.q);
        const language = normalizeText(req.query.lang) || "English";
        if (!query) {
            return res.status(400).json({ message: "Query is required" });
        }
        let meals = await searchMealsByName(query);

        if (!meals.length) {
            const allMeals = await fetchAllMeals();
            meals = findClosestMeals(query, allMeals, 6);
        }

        if (!meals.length && HAS_LLM) {
            const generated = await generateRecipesFromOpenAI({
                message: query,
                language,
                intent: "dish",
                ingredients: []
            });
            meals = generated.recipes.map((recipe) => ({
                ...recipe,
                source: recipe.source || "AI"
            }));
        }

        if (!meals.length) {
            meals = [buildFallbackRecipe(query, language)];
        }

        res.status(200).json({ meals });
    } catch (err) {
        console.error("External search error:", err);
        res.status(500).json({ message: "Failed to fetch external recipes" });
    }
});

app.get("/api/external/ingredients", async (req, res) => {
    try {
        const items = normalizeText(req.query.items);
        const language = normalizeText(req.query.lang) || "English";
        const limit = Number(req.query.limit) || 12;
        if (!items) {
            return res.status(400).json({ message: "Ingredients are required" });
        }
        const ingredients = items.split(",").map((item) => item.trim()).filter(Boolean);
        let meals = await fetchMealsByIngredients(ingredients, limit);

        if (!meals.length && HAS_LLM) {
            const generated = await generateRecipesFromOpenAI({
                message: items,
                language,
                intent: "ingredients",
                ingredients
            });
            meals = generated.recipes.map((recipe) => ({
                ...recipe,
                source: recipe.source || "AI"
            }));
        }

        if (!meals.length) {
            meals = [buildFallbackRecipe(ingredients.join(" & ") || "Chef Special", language, ingredients)];
        }

        res.status(200).json({ meals });
    } catch (err) {
        console.error("External ingredient search error:", err);
        res.status(500).json({ message: "Failed to fetch external recipes" });
    }
});

app.get("/api/external/all", async (req, res) => {
    try {
        const meals = await fetchAllMeals();
        res.status(200).json({ meals });
    } catch (err) {
        console.error("External all meals error:", err);
        res.status(500).json({ message: "Failed to fetch external recipes" });
    }
});

app.post("/api/premium/ingredient-dish", async (req, res) => {
    try {
        const email = normalizeText(req.body.email).toLowerCase();
        const language = normalizeText(req.body.language) || "English";
        const ingredients = sanitizeIngredientInput(req.body.ingredients || []);
        if (!email) {
            return res.status(400).json({ message: "Email is required for premium access." });
        }
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }
        await expirePremiumAccessIfNeeded(user);
        const premiumSnapshot = buildPremiumSnapshot(user);
        if (!premiumSnapshot.premium) {
            return res.status(403).json({
                message: premiumSnapshot.premiumPendingApproval
                    ? "Payment is verified. Waiting for admin to grant premium access."
                    : "Premium access is not active for this user.",
                ...premiumSnapshot
            });
        }
        if (!ingredients.length) {
            return res.status(400).json({ message: "Ingredients are required" });
        }

        const providedNormalized = ingredients.map((item) => normalizeIngredientName(item));
        if (providedNormalized.length < 2) {
            const suggestions = pickNeedMoreSuggestions(ingredients);
            return res.status(200).json({
                status: "need_more",
                reply: buildNeedMoreReply(language, ingredients, suggestions),
                suggestedIngredients: suggestions,
                usedIngredients: ingredients
            });
        }

        const regexes = providedNormalized.map((item) => new RegExp(item, "i"));
        const localPool = await Recipe.find({ status: "approved", "ingredients.name": { $in: regexes } })
            .sort({ createdAt: -1 })
            .limit(120)
            .lean();
        const strictLocal = localPool.find((recipe) => isStrictIngredientRecipe(recipe, providedNormalized));
        if (strictLocal) {
            const recipe = normalizeRecipeOutput({
                ...strictLocal,
                source: "My DB"
            }, language);
            return res.status(200).json({
                status: "success",
                reply: normalizeText(language).toLowerCase() === "tamil"
                    ? "நீங்கள் கொடுத்த பொருட்கள் மட்டும் வைத்து இந்த dish தயாரிக்கலாம்."
                    : "This dish can be prepared using only your provided ingredients.",
                recipe,
                usedIngredients: ingredients,
                suggestedIngredients: []
            });
        }

        const externalMeals = await fetchMealsByIngredients(ingredients, 12);
        const strictExternal = externalMeals.find((recipe) => isStrictIngredientRecipe(recipe, providedNormalized));
        if (strictExternal) {
            const recipe = normalizeRecipeOutput({
                ...strictExternal,
                source: strictExternal.source || "World"
            }, language);
            return res.status(200).json({
                status: "success",
                reply: normalizeText(language).toLowerCase() === "tamil"
                    ? "நீங்கள் கொடுத்த பொருட்கள் மட்டும் வைத்து இந்த dish தயாரிக்கலாம்."
                    : "This dish can be prepared using only your provided ingredients.",
                recipe,
                usedIngredients: ingredients,
                suggestedIngredients: []
            });
        }

        // For premium users prefer a simple dish (few ingredients) even if not a strict exact-match.
        const SIMPLE_THRESHOLD = 5;
        const simpleLocal = localPool.find((r) => {
            const cnt = Array.isArray(r.ingredients) ? r.ingredients.length : 0;
            return cnt > 0 && cnt <= SIMPLE_THRESHOLD && r.ingredients.some((it) => ingredientMatchesProvided(it.name, providedNormalized));
        });
        if (simpleLocal) {
            const recipe = normalizeRecipeOutput({ ...simpleLocal, source: "My DB" }, language);
            return res.status(200).json({
                status: "success",
                reply: normalizeText(language).toLowerCase() === "tamil"
                    ? "இது ஒரு எளிய சிற்றூஞ்சல் பரிந்துரை - உங்கள் பொருட்களில் சில பயன்படுத்தலாம்."
                    : "Simple dish suggestion based on your ingredients.",
                recipe,
                usedIngredients: ingredients,
                suggestedIngredients: []
            });
        }

        const simpleExternal = externalMeals.find((r) => {
            const cnt = Array.isArray(r.ingredients) ? r.ingredients.length : 0;
            return cnt > 0 && cnt <= SIMPLE_THRESHOLD && r.ingredients.some((it) => ingredientMatchesProvided(it.name, providedNormalized));
        });
        if (simpleExternal) {
            const recipe = normalizeRecipeOutput({ ...simpleExternal, source: simpleExternal.source || "World" }, language);
            return res.status(200).json({
                status: "success",
                reply: normalizeText(language).toLowerCase() === "tamil"
                    ? "இது ஒரு எளிய சிற்றூஞ்சல் பரிந்துரை - உங்கள் பொருட்களில் சில பயன்படுத்தலாம்."
                    : "Simple dish suggestion based on your ingredients.",
                recipe,
                usedIngredients: ingredients,
                suggestedIngredients: []
            });
        }

        const llmResult = await generateStrictIngredientDishWithLLM({
            ingredients,
            language
        });
        if (llmResult.status === "success" && llmResult.recipe) {
            return res.status(200).json({
                status: "success",
                reply: llmResult.reply || (
                    normalizeText(language).toLowerCase() === "tamil"
                        ? "உங்கள் ingredients மட்டும் பயன்படுத்தி dish தயார்."
                        : "Recipe generated using only your ingredients."
                ),
                recipe: llmResult.recipe,
                usedIngredients: ingredients,
                suggestedIngredients: []
            });
        }

        const suggestions = llmResult.suggestedIngredients?.length
            ? llmResult.suggestedIngredients
            : pickNeedMoreSuggestions(ingredients);
        res.status(200).json({
            status: "need_more",
            reply: llmResult.reply || buildNeedMoreReply(language, ingredients, suggestions),
            suggestedIngredients: suggestions,
            usedIngredients: ingredients
        });
    } catch (err) {
        console.error("Premium ingredient dish error:", err);
        res.status(500).json({ message: "Failed to generate premium dish" });
    }
});

app.post("/api/assistant", async (req, res) => {
    try {
        const message = normalizeText(req.body.message);
        const language = normalizeText(req.body.language) || "English";
        if (!message) {
            return res.status(400).json({ message: "Message is required" });
        }
        const looksLikeIngredients = message.includes(",") || /ingredients?/i.test(message);
        const cleanMessage = message.replace(/ingredients?:/i, "").trim();

        let recipes = [];
        let reply = "";

        if (looksLikeIngredients) {
            const ingredients = normalizeIngredientList(cleanMessage.split(","));
            const ingredientClauses = ingredients.map((item) => ({
                "ingredients.name": new RegExp(item, "i")
            }));
            const local = ingredientClauses.length
                ? await Recipe.find({ status: "approved", $and: ingredientClauses }).limit(6).lean()
                : [];
            const external = ingredients.length
                ? await fetchMealsByIngredients(ingredients, 6)
                : [];
            recipes = mergeRecipeLists(local, external, 6);

            if (!recipes.length && HAS_LLM) {
                const generated = await generateRecipesFromOpenAI({
                    message,
                    language,
                    intent: "ingredients",
                    ingredients
                });
                recipes = generated.recipes;
                reply = generated.reply;
            }

            if (!recipes.length) {
                recipes = [buildFallbackRecipe(ingredients.join(" & ") || "Chef Special", language, ingredients)];
            }
        } else {
            const query = cleanMessage.replace(/recipe|how to|make|cook/gi, "").trim() || cleanMessage;
            const local = await Recipe.find({ status: "approved", title: new RegExp(query, "i") }).limit(6).lean();
            const external = await searchMealsByName(query);
            recipes = mergeRecipeLists(local, external, 6);

            if (!recipes.length && HAS_LLM) {
                const generated = await generateRecipesFromOpenAI({
                    message,
                    language,
                    intent: "dish",
                    ingredients: []
                });
                recipes = generated.recipes;
                reply = generated.reply;
            }

            if (!recipes.length) {
                recipes = [buildFallbackRecipe(query || "Chef Special", language)];
            }
        }

        if (!reply && HAS_LLM) {
            reply = await generateAssistantReply({ message, language, recipes });
        }

        if (!reply) {
            reply = buildBasicReply(recipes[0], language);
        }

        res.status(200).json({ reply, recipes });
    } catch (err) {
        console.error("Assistant error:", err);
        res.status(500).json({ message: "Assistant error" });
    }
});

app.post("/api/mock-payment/create", async (req, res) => {
    try {
        const email = normalizeText(req.body.email).toLowerCase();
        const requestedPlanId = normalizePlanId(req.body.planId || req.body.plan);
        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }
        if (!isOtpMailConfigured()) {
            return res.status(500).json({
                message: "OTP email service is not configured",
                hint: getOtpConfigHint()
            });
        }
        cleanupExpiredMockPayments();

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }
        await expirePremiumAccessIfNeeded(user);
        const premiumSnapshot = buildPremiumSnapshot(user);
        if (premiumSnapshot.premium) {
            return res.status(400).json({ message: "Premium access is already active for this user." });
        }
        if (premiumSnapshot.premiumPendingApproval) {
            return res.status(400).json({ message: "Payment already verified. Waiting for admin approval." });
        }

        const { plans, defaultPlanId } = await getPremiumPlansConfig();
        if (!Array.isArray(plans) || !plans.length) {
            return res.status(400).json({ message: "No premium plans configured. Please contact admin." });
        }
        const selectedPlan = findPremiumPlanById(plans, requestedPlanId || defaultPlanId);
        if (!selectedPlan) {
            return res.status(400).json({ message: "No premium plans configured. Please contact admin." });
        }
        if (requestedPlanId && selectedPlan.id !== requestedPlanId) {
            return res.status(400).json({ message: "Invalid premium plan selected." });
        }
        const usedOneTimePlanIds = getUsedOneTimePlanIdSet(user);
        const selectedPlanId = normalizePlanId(selectedPlan.id);
        if (selectedPlan.oneTimePerUser && selectedPlanId && usedOneTimePlanIds.has(selectedPlanId)) {
            return res.status(400).json({ message: "This test plan can be used only one time per user." });
        }
        const paymentId = createPaymentId();
        const otp = generatePaymentOtp();
        const expiresAt = Date.now() + PAYMENT_OTP_TTL_MS;

        mockPayments.set(paymentId, {
            email,
            planId: selectedPlan.id,
            amount: selectedPlan.amount,
            currency: selectedPlan.currency,
            planName: selectedPlan.name,
            durationDays: selectedPlan.durationDays,
            oneTimePerUser: Boolean(selectedPlan.oneTimePerUser),
            createdAt: Date.now(),
            otp,
            otpExpiresAt: expiresAt
        });

        try {
            await sendPaymentOtpEmail({
                email,
                otp,
                planName: selectedPlan.name,
                amount: selectedPlan.amount,
                currency: selectedPlan.currency
            });
        } catch (mailErr) {
            mockPayments.delete(paymentId);
            console.error("Mock payment OTP mail error:", mailErr);
            return res.status(500).json({
                message: "Failed to send OTP email",
                hint: getMailErrorHint(mailErr)
            });
        }

        res.status(200).json({
            paymentId,
            status: "created",
            planId: selectedPlan.id,
            amount: selectedPlan.amount,
            currency: selectedPlan.currency,
            planName: selectedPlan.name,
            durationDays: selectedPlan.durationDays,
            otpSentTo: maskEmail(email),
            otpExpiresInSeconds: Math.floor(PAYMENT_OTP_TTL_MS / 1000)
        });
    } catch (err) {
        console.error("Mock payment create error:", err);
        res.status(500).json({ message: "Failed to create mock payment" });
    }
});

app.post("/api/mock-payment/resend-otp", async (req, res) => {
    try {
        const paymentId = normalizeText(req.body.paymentId);
        if (!paymentId) {
            return res.status(400).json({ message: "Payment ID is required" });
        }
        if (!isOtpMailConfigured()) {
            return res.status(500).json({
                message: "OTP email service is not configured",
                hint: getOtpConfigHint()
            });
        }
        cleanupExpiredMockPayments();

        const payment = mockPayments.get(paymentId);
        if (!payment) {
            return res.status(404).json({ message: "Payment not found" });
        }

        payment.otp = generatePaymentOtp();
        payment.otpExpiresAt = Date.now() + PAYMENT_OTP_TTL_MS;
        mockPayments.set(paymentId, payment);

        await sendPaymentOtpEmail({
            email: payment.email,
            otp: payment.otp,
            planName: payment.planName || "Premium Plan",
            amount: payment.amount,
            currency: payment.currency
        });

        res.status(200).json({
            status: "resent",
            otpSentTo: maskEmail(payment.email),
            otpExpiresInSeconds: Math.floor(PAYMENT_OTP_TTL_MS / 1000)
        });
    } catch (err) {
        console.error("Mock payment resend otp error:", err);
        res.status(500).json({
            message: "Failed to resend OTP email",
            hint: getMailErrorHint(err)
        });
    }
});

app.post("/api/mock-payment/confirm", async (req, res) => {
    try {
        const paymentId = normalizeText(req.body.paymentId);
        const otp = normalizeText(req.body.otp);
        if (!paymentId) {
            return res.status(400).json({ message: "Payment ID is required" });
        }
        if (!otp) {
            return res.status(400).json({ message: "OTP is required" });
        }

        cleanupExpiredMockPayments();
        const payment = mockPayments.get(paymentId);
        if (!payment) {
            return res.status(404).json({ message: "Payment not found" });
        }
        if (Date.now() > Number(payment.otpExpiresAt || 0)) {
            return res.status(400).json({ message: "OTP expired. Please request a new OTP." });
        }
        if (otp !== payment.otp) {
            return res.status(400).json({ message: "Invalid OTP" });
        }

        const user = await User.findOne({ email: payment.email });
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }
        if (!normalizePlanId(payment.planId) || !normalizeText(payment.planName)) {
            return res.status(400).json({ message: "Invalid payment plan data. Please retry payment." });
        }

        user.premium = false;
        user.premiumStatus = PREMIUM_STATUS.PAYMENT_PENDING_APPROVAL;
        user.premiumRequestedAt = new Date();
        user.premiumActivatedAt = null;
        user.premiumExpiresAt = null;
        user.premiumPlanId = normalizePlanId(payment.planId, "");
        user.premiumPlanName = normalizeText(payment.planName);
        user.premiumDurationDays = sanitizePremiumDurationDays(payment.durationDays, PREMIUM_DEFAULT_DURATION_DAYS);
        user.premiumAmount = sanitizePremiumAmount(payment.amount, PREMIUM_DEFAULT_AMOUNT);
        user.premiumCurrency = normalizeCurrency(payment.currency, PREMIUM_DEFAULT_CURRENCY);
        user.premiumGrantedBy = "";
        user.premiumRevokedAt = null;
        user.premiumRevokedBy = "";
        await user.save();

        mockPayments.delete(paymentId);
        const snapshot = buildPremiumSnapshot(user);

        res.status(200).json({
            status: "success",
            message: "Payment confirmed. Waiting for admin to grant premium access.",
            ...snapshot
        });
    } catch (err) {
        console.error("Mock payment confirm error:", err);
        res.status(500).json({ message: "Failed to confirm mock payment" });
    }
});

app.delete("/admin/recipes/:id", async (req, res) => {
    try {
        const deletedRecipe = await Recipe.findByIdAndDelete(req.params.id);
        if (!deletedRecipe) {
            return res.status(404).json({ message: "Recipe not found" });
        }
        res.status(200).json({ message: "Recipe deleted successfully" });
    } catch (err) {
        console.error("Error deleting recipe:", err);
        res.status(500).json({ message: "Failed to delete recipe" });
    }
});

app.get("/api/youtube-search", async (req, res) => {
    try {
        const query = (req.query.q || "").trim();
        if (!query) {
            return res.status(400).json({ message: "Query is required" });
        }

        const apiKey = process.env.YT_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ message: "YouTube API key not configured" });
        }

        const url = new URL("https://www.googleapis.com/youtube/v3/search");
        url.searchParams.set("part", "snippet");
        url.searchParams.set("type", "video");
        url.searchParams.set("maxResults", "10");
        url.searchParams.set("q", query);
        url.searchParams.set("key", apiKey);

        const ytRes = await fetch(url.toString());
        if (!ytRes.ok) {
            const errText = await ytRes.text();
            console.error("YouTube API error:", errText);
            return res.status(500).json({ message: "YouTube API error", details: errText });
        }

        const data = await ytRes.json();
        const videos = (data.items || []).map((item) => ({
            id: item.id?.videoId || "",
            title: item.snippet?.title || ""
        })).filter((v) => v.id);

        res.status(200).json({ videos });
    } catch (err) {
        console.error("YouTube search error:", err);
        res.status(500).json({ message: "Failed to fetch videos" });
    }
});

app.put("/admin/recipes/:id", upload.any(), async (req, res) => {
    try {
        const recipe = await Recipe.findById(req.params.id);
        if (!recipe) {
            return res.status(404).json({ message: "Recipe not found" });
        }

        const files = Array.isArray(req.files) ? req.files : [];
        const fileMap = {};
        files.forEach((file) => {
            fileMap[file.fieldname] = file.filename;
        });

        const updated = {};

        if (req.body.title !== undefined) {
            updated.title = normalizeText(req.body.title);
            if (!updated.title) {
                return res.status(400).json({ message: "Title is required" });
            }
        }
        if (req.body.category !== undefined) {
            updated.category = normalizeText(req.body.category);
            if (!updated.category) {
                return res.status(400).json({ message: "Category is required" });
            }
        }
        if (req.body.cuisine !== undefined) {
            updated.cuisine = normalizeText(req.body.cuisine);
            if (!updated.cuisine) {
                return res.status(400).json({ message: "Cuisine is required" });
            }
        }
        if (req.body.instructions !== undefined) {
            updated.instructions = normalizeText(req.body.instructions);
            if (!updated.instructions) {
                return res.status(400).json({ message: "Instructions are required" });
            }
        }
        if (req.body.youtube !== undefined) {
            updated.youtube = normalizeText(req.body.youtube);
        }
        if (req.body.baseServes !== undefined) {
            const parsedServes = Number(req.body.baseServes);
            if (!Number.isFinite(parsedServes) || parsedServes <= 0) {
                return res.status(400).json({ message: "Base serves must be a positive number" });
            }
            updated.baseServes = parsedServes;
        }

        if (req.body.ingredients !== undefined) {
            let rawIngredients = [];
            try {
                rawIngredients = JSON.parse(req.body.ingredients || "[]");
            } catch {
                return res.status(400).json({ message: "Invalid ingredients payload" });
            }

            const ingredients = Array.isArray(rawIngredients)
                ? rawIngredients.map((ingredient) => ({
                    name: normalizeText(ingredient.name),
                    quantity: Number(ingredient.quantity) || 0,
                    unit: normalizeText(ingredient.unit),
                    image:
                        ingredient.imageField && fileMap[ingredient.imageField]
                            ? fileMap[ingredient.imageField]
                            : normalizeText(ingredient.existingImage)
                })).filter((ingredient) => ingredient.name)
                : [];

            updated.ingredients = ingredients;
        }

        if (fileMap.image) {
            updated.image = fileMap.image;
        }

        if (!Object.keys(updated).length) {
            return res.status(400).json({ message: "No valid fields provided for update" });
        }

        const updatedRecipe = await Recipe.findByIdAndUpdate(req.params.id, updated, { new: true });
        res.status(200).json({ message: "Recipe updated successfully", recipe: updatedRecipe });
    } catch (err) {
        console.error("Error updating recipe:", err);
        res.status(500).json({ message: "Failed to update recipe" });
    }
});
