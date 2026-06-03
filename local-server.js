const http = require("http");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const root = __dirname;
const port = Number(process.argv[2] || process.env.PORT || 8000);
const host = process.env.HOST || "127.0.0.1";
const dbPath = path.join(root, "bookings.db");

const emailJsConfig = {
  publicKey: process.env.EMAILJS_PUBLIC_KEY || "atsErfQW1fVRgm7wn",
  serviceId: process.env.EMAILJS_SERVICE_ID || "service_7hq7ytf",
  templateId: process.env.EMAILJS_TEMPLATE_ID || "template_ietrrel",
};

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    service TEXT NOT NULL,
    preferred_date TEXT NOT NULL,
    preferred_time TEXT NOT NULL,
    message TEXT NOT NULL,
    email_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function cleanText(value) {
  return String(value || "").trim();
}

function validateBooking(data) {
  const booking = {
    name: cleanText(data.name),
    phone: cleanText(data.phone),
    email: cleanText(data.email),
    service: cleanText(data.service),
    date: cleanText(data.date),
    time: cleanText(data.time),
    message: cleanText(data.message),
  };

  const missing = Object.entries(booking)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length) {
    return { error: `Missing required fields: ${missing.join(", ")}` };
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(booking.email)) {
    return { error: "Please enter a valid email address" };
  }

  return { booking };
}

function saveBooking(booking, emailSent) {
  const statement = db.prepare(`
    INSERT INTO bookings (
      name, phone, email, service, preferred_date, preferred_time, message, email_sent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = statement.run(
    booking.name,
    booking.phone,
    booking.email,
    booking.service,
    booking.date,
    booking.time,
    booking.message,
    emailSent ? 1 : 0
  );

  return Number(result.lastInsertRowid);
}

async function sendEmail(booking) {
  const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: emailJsConfig.serviceId,
      template_id: emailJsConfig.templateId,
      user_id: emailJsConfig.publicKey,
      template_params: {
        from_name: booking.name,
        reply_to: booking.email,
        name: booking.name,
        email: booking.email,
        phone: booking.phone,
        service: booking.service,
        date: booking.date,
        time: booking.time,
        message: booking.message,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function handleBooking(req, res) {
  try {
    const data = await readJson(req);
    const { booking, error } = validateBooking(data);

    if (error) {
      sendJson(res, 400, { message: error });
      return;
    }

    let emailSent = false;
    let emailError = "";

    try {
      await sendEmail(booking);
      emailSent = true;
    } catch (error) {
      emailError = error.message;
      console.error("EmailJS send failed:", emailError);
    }

    const id = saveBooking(booking, emailSent);
    sendJson(res, 201, { id, emailSent, emailError });
  } catch (error) {
    sendJson(res, 500, { message: error.message || "Unable to save booking" });
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, `http://${host}:${port}`).pathname);
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(root, requested));

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/bookings") {
    handleBooking(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/bookings") {
    const bookings = db
      .prepare("SELECT * FROM bookings ORDER BY created_at DESC LIMIT 100")
      .all();
    sendJson(res, 200, { bookings });
    return;
  }

  serveStatic(req, res);
});

server.listen(port, host, () => {
  console.log(`Serving ${root} at http://${host}:${port}/`);
  console.log(`Booking database: ${dbPath}`);
});
