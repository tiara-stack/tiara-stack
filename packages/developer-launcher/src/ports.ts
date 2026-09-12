import net from "node:net";
import type { PortChecker, PortCheckResult } from "./types";

const portTimeoutMs = 500;

const probeLoopbackPort = (host: "127.0.0.1" | "::1", port: number) =>
  new Promise<PortCheckResult>((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (result: PortCheckResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ available: false, status: "unavailable", reason: "port check timed out" }),
      portTimeoutMs,
    );
    socket.once("connect", () => {
      clearTimeout(timer);
      finish({ available: false, status: "occupied", reason: "a process is already listening" });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED") {
        finish({ available: true, status: "available" });
      } else if (
        error.code === "EAFNOSUPPORT" ||
        error.code === "EADDRNOTAVAIL" ||
        error.code === "ENETUNREACH"
      ) {
        finish({ available: false, status: "unsupported", reason: error.code });
      } else {
        finish({
          available: false,
          status: "unavailable",
          reason: error.code ?? "port check failed",
        });
      }
    });
  });

export const checkLoopbackPort: PortChecker = async (port: number) => {
  const results = await Promise.all([
    probeLoopbackPort("127.0.0.1", port),
    probeLoopbackPort("::1", port),
  ]);
  const occupied = results.find((result) => result.status === "occupied");
  if (occupied !== undefined) return occupied;
  if (results.some((result) => result.status === "available")) {
    return { available: true, status: "available" };
  }
  const unavailable = results.find((result) => result.status === "unavailable");
  if (unavailable !== undefined) return unavailable;
  return results[0] ?? { available: false, status: "unsupported" };
};
