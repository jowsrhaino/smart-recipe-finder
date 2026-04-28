import "dotenv/config";
import { spawn } from "child_process";
import ngrok from "@ngrok/ngrok";

const port = Number(process.env.PORT || 4000);
const host = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const token = String(process.env.NGROK_AUTHTOKEN || "").trim();

if (!token) {
    console.error("[ngrok] NGROK_AUTHTOKEN missing in .env file");
    process.exit(1);
}

let backendProcess = null;
let isShuttingDown = false;

async function closeTunnel() {
    try {
        await ngrok.kill();
        console.log("[ngrok] Old tunnels closed");
    } catch {
        // ignore
    }
}

async function shutdown(code = 0) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log("\n[system] Shutting down...");

    if (backendProcess && !backendProcess.killed) {
        backendProcess.kill("SIGINT");
    }

    await closeTunnel();
    process.exit(code);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
    console.log("[ngrok] Starting tunnel...");

    // Close previous tunnels
    await closeTunnel();

    const listener = await ngrok.forward({
        addr: port,
        authtoken: token,
        pooling_enabled: true
    });

    const publicUrl = listener.url();

    console.log("--------------------------------------------------");
    console.log("🌍 PUBLIC URL:");
    console.log(publicUrl);
    console.log("--------------------------------------------------");
    console.log(`📦 Backend running on: http://${host}:${port}`);
    console.log("");

    backendProcess = spawn(process.execPath, ["backend.js"], {
        stdio: "inherit",
        windowsHide: true,
        env: {
            ...process.env,
            PORT: String(port),
            HOST: host,
            APP_BASE_URL: publicUrl
        }
    });

    backendProcess.on("exit", (code) => {
        shutdown(code ?? 0);
    });
}

main().catch(async (err) => {
    console.error("[ngrok] Error:", err?.message || err);
    await shutdown(1);
});