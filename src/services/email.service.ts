import nodemailer from "nodemailer";

const ICON_BASE64 = "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";

function createTransport() {
  const user    = process.env.GMAIL_SENDER_EMAIL ?? "";
  const appPass = process.env.GMAIL_APP_PASSWORD ?? "";

  if (!user || !appPass) {
    throw new Error("Email not configured: GMAIL_SENDER_EMAIL and GMAIL_APP_PASSWORD are required");
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass: appPass },
  });
}

export async function sendResetPasswordEmail(
  toEmail: string,
  resetLink: string,
  recipientName: string | undefined,
  expiresInMinutes: number,
): Promise<void> {
  const transport   = createTransport();
  const senderEmail = process.env.GMAIL_SENDER_EMAIL ?? "";
  const senderName  = process.env.GMAIL_SENDER_NAME ?? "Bearth Admin";
  const displayName = recipientName ?? toEmail;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <tr><td style="background:#1a1f2e;padding:28px 40px 24px;text-align:center;">
          <img src="cid:bearthicon@bearth" alt="Bearth" width="52" height="52"
               style="display:block;margin:0 auto 10px;border-radius:14px;box-shadow:0 0 0 3px rgba(65,175,235,0.25),0 8px 24px rgba(0,0,0,0.3);" />
          <h1 style="color:#41afeb;margin:0;font-size:20px;font-weight:700;letter-spacing:1px;">BEARTH ADMIN</h1>
        </td></tr>

        <tr><td style="padding:40px 40px 24px;">
          <p style="color:#374151;font-size:15px;margin:0 0 16px;">Hi ${displayName},</p>
          <p style="color:#374151;font-size:15px;margin:0 0 24px;">
            We received a request to reset your Bearth Admin password.
            Click the button below to set a new password.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${resetLink}"
               style="display:inline-block;background:#41afeb;color:#ffffff;text-decoration:none;
                      padding:14px 36px;border-radius:8px;font-size:15px;font-weight:600;">
              Reset Password
            </a>
          </div>
          <p style="color:#6b7280;font-size:13px;margin:0 0 8px;">Or copy this link into your browser:</p>
          <p style="color:#41afeb;font-size:12px;word-break:break-all;margin:0 0 24px;">${resetLink}</p>
          <p style="color:#9ca3af;font-size:13px;margin:0;">
            This link expires in <strong>${expiresInMinutes % 60 === 0 ? `${expiresInMinutes / 60} hour${expiresInMinutes === 60 ? "" : "s"}` : `${expiresInMinutes} minutes`}</strong>.
            If you did not request a password reset, ignore this email.
          </p>
        </td></tr>

        <tr><td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
          <p style="color:#9ca3af;font-size:12px;margin:0;">
            &copy; ${new Date().getFullYear()} Bearth Admin &mdash; Ample Group Global
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await transport.sendMail({
    from:    `"${senderName}" <${senderEmail}>`,
    to:      toEmail,
    subject: "Reset Your Bearth Admin Password",
    html,
    attachments: [
      {
        filename:    "icon.png",
        content:     Buffer.from(ICON_BASE64, "base64"),
        contentType: "image/png",
        cid:         "bearthicon@bearth",
      },
    ],
  });
}
