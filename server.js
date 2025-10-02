// server.js
import 'dotenv/config';
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ✅ parse JSON bodies (big enough for data URLs from the camera)
app.use(express.json({ limit: "15mb" }));

// serve index.html and assets
app.use(express.static(__dirname));

// API route
import pipelineHandler from "./api/pipeline.js";
app.post("/api/pipeline", (req, res) => pipelineHandler(req, res));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`EdVenture running at http://localhost:${PORT}`));
