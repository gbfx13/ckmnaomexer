// POST /api/estimate
// Receives the "Request a Free Estimate" form, saves it, emails the business
// and sends an automatic confirmation to the customer.
//
// All secrets come from environment variables (see .env.example).
// Nothing in this file is shipped to the browser.

import Busboy from 'busboy';
import nodemailer from 'nodemailer';

const env = (k, d = '') => (process.env[k] ?? d).trim();

const NOTIFY_TO = () => env('NOTIFY_TO', 'ckmmultiservicess@gmail.com');
const COMPANY = {
  name: 'CKM Multiservices LLC',
  phone: '+1 (321) 240-0711',
  email: 'ckmmultiservicess@gmail.com',
  address: '6735 Conroy Windermere Rd, Suite 233, Orlando, FL 32835',
  hours: 'Monday – Friday, 9:00 AM – 5:00 PM',
};

const SERVICES = ['Gutter', 'Soffit', 'Fascia', 'Vinyl Siding', 'Leaf Guard'];
const TIMES = ['', 'Morning (9 AM – 12 PM)', 'Afternoon (12 PM – 5 PM)'];
const LIMITS = { files: 10, fileSize: 5 * 1024 * 1024, total: 4 * 1024 * 1024 };

/* ---------------- helpers ---------------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s, max = 300) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const oneLine = (s, max) => clean(s, max).replace(/[\r\n]+/g, ' ');
const safeName = (n) => oneLine(n || 'photo', 120).replace(/[^\w.\- ()]/g, '_') || 'photo';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function cors(req, res) {
  const allowed = env('ALLOWED_ORIGIN'); // optional, e.g. https://www.ckmmultiservices.com
  if (allowed && req.headers.origin === allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: LIMITS.files, fileSize: LIMITS.fileSize, fields: 40, fieldSize: 8000 } });
    } catch (e) {
      return reject(Object.assign(new Error('Invalid form data'), { status: 400 }));
    }
    const fields = { service: [] };
    const files = [];
    let total = 0;
    bb.on('field', (name, val) => {
      if (name === 'service') fields.service.push(val);
      else fields[name] = val;
    });
    bb.on('file', (_name, stream, info) => {
      const chunks = [];
      let size = 0;
      stream.on('data', (d) => { size += d.length; chunks.push(d); });
      stream.on('end', () => {
        if (!size || stream.truncated) return;
        if (!/^image\/(jpeg|png|webp|heic|heif|gif)$/i.test(info.mimeType)) return;
        if (total + size > LIMITS.total) return; // keep the request under the host's body limit
        total += size;
        files.push({ filename: safeName(info.filename), contentType: info.mimeType, content: Buffer.concat(chunks), size });
      });
    });
    bb.on('error', (e) => reject(Object.assign(e, { status: 400 })));
    bb.on('close', () => resolve({ fields, files }));
    req.pipe(bb);
  });
}

function validate(f) {
  const d = {
    firstName: oneLine(f.firstName, 80),
    lastName: oneLine(f.lastName, 80),
    email: oneLine(f.email, 160).toLowerCase(),
    phone: oneLine(f.phone, 30),
    address: oneLine(f.address, 200),
    city: oneLine(f.city, 80),
    state: oneLine(f.state, 2).toUpperCase(),
    zip: oneLine(f.zip, 10),
    services: [...new Set((f.service || []).map((s) => oneLine(s, 40)))].filter((s) => SERVICES.includes(s)),
    prefDay: oneLine(f.prefDay, 10),
    prefTime: TIMES.includes(oneLine(f.prefTime, 40)) ? oneLine(f.prefTime, 40) : '',
    message: clean(f.message, 4000),
    lang: ['en', 'pt', 'es'].includes(f.lang) ? f.lang : 'en',
  };
  const errors = [];
  if (!d.firstName) errors.push('firstName');
  if (!d.lastName) errors.push('lastName');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) errors.push('email');
  if (d.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '').length !== 10) errors.push('phone');
  if (!d.address) errors.push('address');
  if (!d.city) errors.push('city');
  if (!/^[A-Z]{2}$/.test(d.state)) errors.push('state');
  if (!/^\d{5}(-\d{4})?$/.test(d.zip)) errors.push('zip');
  if (!d.services.length) errors.push('service');
  if (d.prefDay && !/^\d{4}-\d{2}-\d{2}$/.test(d.prefDay)) d.prefDay = '';
  return { d, errors };
}

const fmtDay = (iso) => {
  if (!iso) return 'No preference';
  const dt = new Date(iso + 'T12:00:00Z');
  return isNaN(dt) ? iso : dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};
const fmtSize = (b) => (b > 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

/* ---------------- storage (Supabase / Postgres) ---------------- */

async function saveRequest(d, files) {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    console.warn('[estimate] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set: request not saved to database');
    return null;
  }
  const row = {
    first_name: d.firstName, last_name: d.lastName, email: d.email, phone: d.phone,
    address: d.address, city: d.city, state: d.state, zip: d.zip,
    services: d.services, preferred_day: d.prefDay || null, preferred_time: d.prefTime || null,
    details: d.message || null, photo_names: files.map((f) => f.filename), language: d.lang,
  };
  const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/estimate_requests`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`Database save failed (${r.status}): ${await r.text()}`);
  const [saved] = await r.json();
  return saved;
}

/* ---------------- email ---------------- */

function transporter() {
  const host = env('SMTP_HOST');
  const user = env('SMTP_USER');
  const pass = env('SMTP_PASS');
  if (!host || !user || !pass) throw Object.assign(new Error('SMTP is not configured'), { status: 500 });
  const port = Number(env('SMTP_PORT', '465'));
  return nodemailer.createTransport({ host, port, secure: env('SMTP_SECURE', port === 465 ? 'true' : 'false') === 'true', auth: { user, pass } });
}

function businessEmail(d, files, id) {
  const name = `${d.firstName} ${d.lastName}`;
  const rows = [
    ['Customer Name', name],
    ['Email', d.email],
    ['Phone', d.phone],
    ['Project Address', d.address],
    ['City', d.city],
    ['State', d.state],
    ['ZIP', d.zip],
    ['Service Requested', d.services.join(', ')],
    ['Preferred Day', fmtDay(d.prefDay)],
    ['Preferred Time', d.prefTime || 'No preference'],
    ['Project Details', d.message || '(none)'],
  ];
  const photoLines = files.map((f, i) => `${i + 1}. ${f.filename} (${fmtSize(f.size)})`);
  const text = [
    'New Free Estimate Request - CKM Multiservices', '',
    ...rows.map(([k, v]) => `${k}: ${v}`), '',
    files.length ? `Photos (${files.length}, attached):\n${photoLines.join('\n')}` : 'Photos: none',
    '', id ? `Request ID: ${id}` : '', `Customer language: ${d.lang.toUpperCase()}`,
    'Reply to this email to respond to the customer directly.',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#10213a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #d7dde6;border-radius:8px;overflow:hidden">
    <tr><td style="background:#0b2350;padding:20px 24px;color:#ffffff">
      <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#74c655;font-weight:bold">New lead</div>
      <div style="font-size:22px;font-weight:bold;margin-top:6px">New Free Estimate Request</div>
      <div style="font-size:14px;color:#a9b8d3;margin-top:4px">${esc(d.services.join(', '))} &middot; ${esc(d.city)}, ${esc(d.state)}</div>
    </td></tr>
    <tr><td style="padding:8px 24px 4px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
        ${rows.map(([k, v]) => `<tr><td style="padding:10px 12px 10px 0;border-bottom:1px solid #e6eaf0;color:#4a5870;width:38%;vertical-align:top">${esc(k)}</td><td style="padding:10px 0;border-bottom:1px solid #e6eaf0;font-weight:bold;vertical-align:top;white-space:pre-wrap">${
          k === 'Email' ? `<a href="mailto:${esc(v)}" style="color:#1653b8">${esc(v)}</a>` :
          k === 'Phone' ? `<a href="tel:${esc(v.replace(/[^\d+]/g, ''))}" style="color:#1653b8">${esc(v)}</a>` : esc(v)}</td></tr>`).join('')}
      </table>
    </td></tr>
    <tr><td style="padding:16px 24px">
      <div style="font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;color:#4a5870;margin-bottom:6px">Photos</div>
      ${files.length ? `<ol style="margin:0;padding-left:20px;font-size:14px">${files.map((f) => `<li>${esc(f.filename)} <span style="color:#4a5870">(${fmtSize(f.size)})</span></li>`).join('')}</ol><div style="font-size:12px;color:#4a5870;margin-top:6px">Attached to this email.</div>` : '<div style="font-size:14px;color:#4a5870">No photos were uploaded.</div>'}
    </td></tr>
    <tr><td style="padding:14px 24px 22px;font-size:12px;color:#4a5870;border-top:1px solid #e6eaf0">
      ${id ? `Request ID: ${esc(id)}<br>` : ''}Customer language: ${esc(d.lang.toUpperCase())}<br>Reply to this email to respond to ${esc(d.firstName)} directly.
    </td></tr>
  </table></td></tr></table></body></html>`;
  return {
    to: NOTIFY_TO(),
    replyTo: { name, address: d.email },
    subject: 'New Free Estimate Request - CKM Multiservices',
    text, html,
    attachments: files.map((f) => ({ filename: f.filename, content: f.content, contentType: f.contentType })),
  };
}

const COPY = {
  en: {
    hi: (n) => `Hi ${n},`,
    p1: 'Thank you for contacting CKM Multiservices. We received your request for a free estimate.',
    p2: 'We will review your request and contact you to discuss your project and schedule a visit.',
    summary: 'Your request', services: 'Service Requested', address: 'Project Address', day: 'Preferred Day', time: 'Preferred Time', photos: 'Photos',
    questions: 'If you have any questions in the meantime, call or WhatsApp us at',
    orEmail: 'or email', hours: 'Office hours: Monday – Friday, 9:00 AM – 5:00 PM.',
    thanks: 'Thank you,', noPref: 'No preference', none: 'None',
    auto: 'This is an automatic confirmation. You can reply to this email to reach our team.',
  },
  pt: {
    hi: (n) => `Olá, ${n},`,
    p1: 'Obrigado por entrar em contato com a CKM Multiservices. Recebemos o seu pedido de orçamento gratuito.',
    p2: 'Vamos analisar o seu pedido e entrar em contato para conversar sobre o projeto e agendar uma visita.',
    summary: 'Seu pedido', services: 'Serviço solicitado', address: 'Endereço do projeto', day: 'Dia de preferência', time: 'Horário de preferência', photos: 'Fotos',
    questions: 'Se tiver alguma dúvida enquanto isso, ligue ou mande WhatsApp para',
    orEmail: 'ou envie um e-mail para', hours: 'Horário de atendimento: segunda a sexta, das 9h às 17h.',
    thanks: 'Obrigado,', noPref: 'Sem preferência', none: 'Nenhuma',
    auto: 'Esta é uma confirmação automática. Você pode responder este e-mail para falar com a nossa equipe.',
  },
  es: {
    hi: (n) => `Hola, ${n}:`,
    p1: 'Gracias por comunicarse con CKM Multiservices. Recibimos su solicitud de estimado gratis.',
    p2: 'Revisaremos su solicitud y nos comunicaremos con usted para hablar de su proyecto y programar una visita.',
    summary: 'Su solicitud', services: 'Servicio solicitado', address: 'Dirección del proyecto', day: 'Día preferido', time: 'Horario preferido', photos: 'Fotos',
    questions: 'Si tiene alguna pregunta mientras tanto, llámenos o escríbanos por WhatsApp al',
    orEmail: 'o envíe un correo a', hours: 'Horario de atención: lunes a viernes, 9:00 AM – 5:00 PM.',
    thanks: 'Gracias,', noPref: 'Sin preferencia', none: 'Ninguna',
    auto: 'Esta es una confirmación automática. Puede responder a este correo para comunicarse con nuestro equipo.',
  },
};

const SVC_T = {
  pt: { Gutter: 'Calha', Soffit: 'Soffit', Fascia: 'Fascia', 'Vinyl Siding': 'Siding de Vinil', 'Leaf Guard': 'Protetor de Calha' },
  es: { Gutter: 'Canaletas', Soffit: 'Soffit', Fascia: 'Fascia', 'Vinyl Siding': 'Siding de Vinilo', 'Leaf Guard': 'Protectores de Canaletas' },
};
const TIME_T = {
  pt: { 'Morning (9 AM – 12 PM)': 'Manhã (9h – 12h)', 'Afternoon (12 PM – 5 PM)': 'Tarde (12h – 17h)' },
  es: { 'Morning (9 AM – 12 PM)': 'Mañana (9 AM – 12 PM)', 'Afternoon (12 PM – 5 PM)': 'Tarde (12 PM – 5 PM)' },
};

function customerEmail(d, files) {
  const c = COPY[d.lang] || COPY.en;
  const svc = (x) => SVC_T[d.lang]?.[x] || x;
  const tm = (x) => TIME_T[d.lang]?.[x] || x;
  const locale = { en: 'en-US', pt: 'pt-BR', es: 'es-US' }[d.lang];
  const day = d.prefDay
    ? new Date(d.prefDay + 'T12:00:00Z').toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
    : c.noPref;
  const rows = [
    [c.services, d.services.map(svc).join(', ')],
    [c.address, `${d.address}, ${d.city}, ${d.state} ${d.zip}`],
    [c.day, day],
    [c.time, d.prefTime ? tm(d.prefTime) : c.noPref],
    [c.photos, files.length ? String(files.length) : c.none],
  ];
  const text = [
    c.hi(d.firstName), '', c.p1, '', c.p2, '', `${c.summary}:`, ...rows.map(([k, v]) => `- ${k}: ${v}`), '',
    `${c.questions} ${COMPANY.phone} ${c.orEmail} ${COMPANY.email}.`, c.hours, '',
    c.thanks, COMPANY.name, COMPANY.address, '', c.auto,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#10213a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #d7dde6;border-radius:8px;overflow:hidden">
    <tr><td style="background:#0b2350;padding:22px 24px">
      <span style="font-size:22px;font-weight:900;color:#74c655">CKM</span> <span style="font-size:22px;font-weight:900;color:#ffffff">Multiservices</span>
    </td></tr>
    <tr><td style="padding:24px;font-size:15px;line-height:1.6">
      <p style="margin:0 0 14px">${esc(c.hi(d.firstName))}</p>
      <p style="margin:0 0 14px">${esc(c.p1)}</p>
      <p style="margin:0 0 20px">${esc(c.p2)}</p>
      <div style="font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;color:#4a5870;margin-bottom:6px">${esc(c.summary)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;background:#f4f6f8;border-radius:6px">
        ${rows.map(([k, v]) => `<tr><td style="padding:9px 12px;color:#4a5870;width:40%;vertical-align:top">${esc(k)}</td><td style="padding:9px 12px;font-weight:bold">${esc(v)}</td></tr>`).join('')}
      </table>
      <p style="margin:20px 0 6px">${esc(c.questions)} <a href="tel:+13212400711" style="color:#1653b8;font-weight:bold">${COMPANY.phone}</a> ${esc(c.orEmail)} <a href="mailto:${COMPANY.email}" style="color:#1653b8">${COMPANY.email}</a>.</p>
      <p style="margin:0 0 20px;color:#4a5870;font-size:14px">${esc(c.hours)}</p>
      <p style="margin:0">${esc(c.thanks)}<br><strong>${COMPANY.name}</strong><br><span style="color:#4a5870;font-size:13px">${COMPANY.address}</span></p>
    </td></tr>
    <tr><td style="padding:14px 24px;font-size:12px;color:#4a5870;border-top:1px solid #e6eaf0">${esc(c.auto)}</td></tr>
  </table></td></tr></table></body></html>`;
  return {
    to: { name: `${d.firstName} ${d.lastName}`, address: d.email },
    replyTo: NOTIFY_TO(),
    subject: 'We Received Your Estimate Request - CKM Multiservices',
    text, html,
  };
}

/* ---------------- handler ---------------- */

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!/multipart\/form-data/i.test(req.headers['content-type'] || '')) return send(res, 415, { ok: false, error: 'Expected multipart/form-data' });

  try {
    const { fields, files } = await parseMultipart(req);

    // Spam trap: real visitors never see or fill this field.
    if (clean(fields.company_website)) return send(res, 200, { ok: true });

    const { d, errors } = validate(fields);
    if (errors.length) return send(res, 422, { ok: false, error: 'Please check the highlighted fields.', fields: errors });

    // 1. Save the request (a database problem must not lose the lead, so we log and continue).
    let saved = null;
    try { saved = await saveRequest(d, files); } catch (e) { console.error('[estimate] save error:', e.message); }

    // 2. Email the business. If this fails the customer is told to call instead.
    const mail = transporter();
    const from = env('MAIL_FROM', `CKM Multiservices <${env('SMTP_USER')}>`);
    await mail.sendMail({ from, ...businessEmail(d, files, saved?.id) });

    // 3. Confirmation to the customer (a failure here is logged, not shown).
    try { await mail.sendMail({ from, ...customerEmail(d, files) }); }
    catch (e) { console.error('[estimate] confirmation email error:', e.message); }

    return send(res, 200, { ok: true, id: saved?.id ?? null });
  } catch (e) {
    console.error('[estimate] error:', e.message);
    return send(res, e.status && e.status < 500 ? e.status : 500, { ok: false, error: 'We could not send your request. Please call us at +1 (321) 240-0711.' });
  }
}
