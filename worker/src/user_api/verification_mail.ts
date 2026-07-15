const VERIFY_CODE_TTL_SECONDS = 300;
const DEFAULT_BRAND_NAME = "Cloudflare Temp Email";

export type VerificationMailOptions = {
    brandName?: string;
    logoUrl?: string;
};

export type VerificationMail = {
    fromName: string;
    subject: string;
    html: string;
    text: string;
};

const normalizeBrandName = (brandName: string | undefined): string => {
    const normalized = [...(brandName || "")]
        .map((character) => {
            const codePoint = character.codePointAt(0) || 0;
            return codePoint <= 31 || codePoint === 127 ? " " : character;
        })
        .join("")
        .trim();
    return normalized ? normalized.slice(0, 80) : DEFAULT_BRAND_NAME;
};

const normalizeLogoUrl = (logoUrl: string | undefined): string | undefined => {
    if (!logoUrl?.trim()) return undefined;
    try {
        const parsed = new URL(logoUrl.trim());
        return parsed.protocol === "https:" ? parsed.toString() : undefined;
    } catch {
        return undefined;
    }
};

const escapeHtml = (value: string): string => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function buildVerificationMail(
    code: string,
    options: VerificationMailOptions = {},
): VerificationMail {
    const expiresInMinutes = Math.max(1, Math.round(VERIFY_CODE_TTL_SECONDS / 60));
    const brandName = normalizeBrandName(options.brandName);
    const logoUrl = normalizeLogoUrl(options.logoUrl);
    const escapedBrandName = escapeHtml(brandName);
    const escapedCode = escapeHtml(code);
    const brandMarkup = logoUrl
        ? `<img src="${escapeHtml(logoUrl)}" width="180" alt="${escapedBrandName}" style="display:block;width:auto;height:auto;max-width:180px;max-height:64px;margin:0;border:0;outline:none;text-decoration:none;object-fit:contain;object-position:left center;color:#111111;font-size:18px;line-height:1.3;font-weight:600;">`
        : `<div style="color:#111111;font-size:20px;line-height:1.3;font-weight:650;letter-spacing:-0.3px;">${escapedBrandName}</div>`;

    return {
        fromName: brandName,
        subject: `${code} 是你的 ${brandName} 验证码`,
        text: [
            brandName,
            "",
            "确认你的邮箱",
            "使用下面的验证码完成账号注册：",
            "",
            code,
            "",
            `验证码将在 ${expiresInMinutes} 分钟后失效。`,
            `请勿向任何人透露此验证码。${brandName} 不会通过电话或聊天向你索取验证码。`,
            "",
            "如果这不是你的操作，可以忽略此邮件。",
        ].join("\n"),
        html: `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapedBrandName} 验证码</title>
</head>
<body style="margin:0;padding:0;background-color:#ffffff;color:#202123;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',Arial,sans-serif;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">你的验证码是 ${escapedCode}，${expiresInMinutes} 分钟内有效。</div>
  <div style="width:100%;background-color:#ffffff;">
    <div style="width:100%;max-width:440px;margin:0 auto;padding:0 24px;box-sizing:border-box;text-align:left;">
      <div style="padding:34px 0 30px;">
        ${brandMarkup}
      </div>
      <h1 style="margin:0;color:#202123;font-size:27px;line-height:1.32;font-weight:600;letter-spacing:-0.6px;">确认你的邮箱</h1>
      <p style="margin:17px 0 0;color:#565869;font-size:16px;line-height:1.72;">输入下面的验证码，完成 ${escapedBrandName} 账号注册。</p>
      <div style="margin:28px 0 27px;padding:27px 12px 25px;background-color:#f7f7f8;border-radius:10px;text-align:center;">
        <div style="color:#202123;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:38px;line-height:1.15;font-weight:600;letter-spacing:7px;padding-left:7px;white-space:nowrap;text-align:center;">${escapedCode}</div>
        <div style="margin-top:11px;color:#8e8ea0;font-size:13px;line-height:1.5;text-align:center;">${expiresInMinutes} 分钟内有效</div>
      </div>
      <p style="margin:0;color:#565869;font-size:14px;line-height:1.75;">请勿向任何人透露此验证码。${escapedBrandName} 不会通过电话或聊天向你索取验证码。</p>
      <p style="margin:17px 0 0;color:#8e8ea0;font-size:14px;line-height:1.75;">如果这不是你的操作，可以忽略此邮件。</p>
      <div style="padding:38px 0 38px;">
        <div style="height:1px;background-color:#e5e5e5;font-size:0;line-height:0;">&nbsp;</div>
        <p style="margin:19px 0 0;color:#8e8ea0;font-size:12px;line-height:1.7;">此邮件由 ${escapedBrandName} 自动发送，请勿直接回复。</p>
      </div>
    </div>
  </div>
</body>
</html>`,
    };
}

export { DEFAULT_BRAND_NAME, VERIFY_CODE_TTL_SECONDS };
