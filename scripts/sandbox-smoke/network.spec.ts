// Runs INSIDE the execution sandbox. Every test PASSES when the egress filter holds, except the last, which PASSES when the
// one declared origin still loads in a real browser.
import { test, expect } from "@playwright/test";
import dgram from "node:dgram";
import net from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// What the harness tells the specs, written beside them by the orchestrator.
const context = JSON.parse(readFileSync(join(process.cwd(), "smoke-context.json"), "utf8")) as { undeclared: string; apiPort: number };
const UNDECLARED = context.undeclared;
const API_PORT = context.apiPort;

function connectOutcome(host: string, port: number, send?: string): Promise<"connected-and-answered" | "refused-or-closed"> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (outcome: "connected-and-answered" | "refused-or-closed"): void => { socket.destroy(); resolve(outcome); };
    const timer = setTimeout(() => done("refused-or-closed"), 6000);
    socket.on("connect", () => { if (send) socket.write(send); });
    socket.on("data", () => { clearTimeout(timer); done("connected-and-answered"); });
    socket.on("error", () => { clearTimeout(timer); done("refused-or-closed"); });
    socket.on("close", () => { clearTimeout(timer); done("refused-or-closed"); });
  });
}

test("an undeclared host cannot be fetched", async () => {
  const outcome = await fetch(UNDECLARED, { signal: AbortSignal.timeout(8000) }).then(() => "reached", () => "refused");
  expect(outcome).toBe("refused");
});

test("a raw TCP connection to a public address is reset, not carried", async () => {
  expect(await connectOutcome("1.1.1.1", 443, "GET / HTTP/1.1\r\nHost: attacker.example.net\r\n\r\n")).toBe("refused-or-closed");
});

test("a DNS query straight to a public resolver is answered by the filter: the undeclared name does not exist", async () => {
  const query = Buffer.from("123401000001000000000000076578616d706c65036f726700000100" + "01", "hex");
  const rcode = await new Promise<number | "none">((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); resolve("none"); }, 3000);
    socket.once("message", (message) => { clearTimeout(timer); socket.close(); resolve(message.readUInt16BE(2) & 0x0f); });
    socket.send(query, 53, "8.8.8.8");
  });
  expect(rcode === 3 || rcode === "none").toBe(true);
});

test("UDP to any other port of a public address does not leave", async () => {
  const outcome = await new Promise<"answered" | "silent">((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); resolve("silent"); }, 2500);
    socket.once("message", () => { clearTimeout(timer); socket.close(); resolve("answered"); });
    socket.once("error", () => { clearTimeout(timer); socket.close(); resolve("silent"); });
    socket.send(Buffer.from("ping"), 5353, "1.1.1.1");
  });
  expect(outcome).toBe("silent");
});

test("IPv6 is closed", async () => {
  expect(await connectOutcome("2606:4700:4700::1111", 443)).toBe("refused-or-closed");
});

test("the API on the orchestrator's own loopback cannot be reached", async () => {
  expect(await connectOutcome("127.0.0.1", API_PORT, "GET /api/health HTTP/1.1\r\nHost: localhost\r\n\r\n")).toBe("refused-or-closed");
});

test("the declared origin loads in a real browser", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);
});
