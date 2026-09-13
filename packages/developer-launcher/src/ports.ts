import net from "node:net";
import { Effect } from "effect";
import type { PortChecker, PortCheckResult } from "./types";

const portTimeoutMs = 500;

const probeLoopbackPortEffect = (host: "127.0.0.1" | "::1", port: number) =>
  Effect.callback<PortCheckResult>((resume) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (result: PortCheckResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(result));
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
    return Effect.sync(() => {
      clearTimeout(timer);
      socket.destroy();
    });
  });

const checkLoopbackPortEffect = (port: number) =>
  Effect.all([probeLoopbackPortEffect("127.0.0.1", port), probeLoopbackPortEffect("::1", port)], {
    concurrency: "unbounded",
  });

export const checkLoopbackPort: PortChecker = (port) =>
  Effect.runPromise(
    checkLoopbackPortEffect(port).pipe(
      Effect.map((results) => {
        const occupied = results.find((result) => result.status === "occupied");
        if (occupied !== undefined) return occupied;
        if (results.some((result) => result.status === "available")) {
          return { available: true, status: "available" };
        }
        const unavailable = results.find((result) => result.status === "unavailable");
        if (unavailable !== undefined) return unavailable;
        return results[0] ?? { available: false, status: "unsupported" };
      }),
    ),
  );
