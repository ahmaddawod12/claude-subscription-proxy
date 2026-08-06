/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints that wrap Claude Code CLI
 */

import express, { Express, Request, Response, NextFunction } from "express";
import { createServer, Server } from "http";
import { handleChatCompletions, handleModels, handleHealth } from "./routes.js";

export interface ServerConfig {
  port: number;
  host?: string;
}

let serverInstance: Server | null = null;
let serverStartPromise: Promise<Server> | null = null;
let serverStopPromise: Promise<void> | null = null;

interface ApiError extends Error {
  status?: number;
  apiType?: string;
  apiCode?: string | null;
}

/**
 * Create and configure the Express app
 */
function createApp(): Express {
  const app = express();

  // Middleware: use raw body parser + manual JSON parse for better error diagnostics
  app.use(express.raw({ type: "application/json", limit: "10mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
      const raw = req.body.toString("utf8");
      if (process.env.DEBUG) {
        console.log("[Body raw]:", raw.substring(0, 200));
      }
      try {
        req.body = JSON.parse(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[Body parse error]:", msg);
        if (process.env.DEBUG) {
          console.error("[Body raw]:", raw.substring(0, 300));
        } else {
          console.error("[Body metadata]:", {
            length: raw.length,
            method: req.method,
            url: req.originalUrl,
          });
        }
        const parseError = new Error(
          "Request body contains invalid JSON"
        ) as ApiError;
        parseError.status = 400;
        parseError.apiType = "invalid_request_error";
        parseError.apiCode = "invalid_json";
        return next(parseError);
      }
    }
    next();
  });

  // Request logging (debug mode)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (process.env.DEBUG) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
  });

  // CORS headers for local development
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
  });

  // Handle OPTIONS preflight
  app.options("*", (_req: Request, res: Response) => {
    res.sendStatus(200);
  });

  // Routes
  app.get("/health", handleHealth);
  app.get("/v1/models", handleModels);
  app.post("/v1/chat/completions", handleChatCompletions);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: "Not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });

  // Error handler
  app.use((err: ApiError, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[Server Error]:", err.message);
    const status =
      typeof err.status === "number" && err.status >= 400 && err.status < 600
        ? err.status
        : 500;
    const isClientError = status < 500;

    res.status(status).json({
      error: {
        message: err.message,
        type:
          err.apiType ||
          (isClientError ? "invalid_request_error" : "server_error"),
        code: err.apiCode ?? null,
      },
    });
  });

  return app;
}

/**
 * Start the HTTP server
 */
export async function startServer(config: ServerConfig): Promise<Server> {
  const { port, host = "127.0.0.1" } = config;

  if (serverStopPromise) {
    console.log("[Server] Shutdown in progress, waiting before restart");
    await serverStopPromise;
    return startServer(config);
  }

  if (serverStartPromise) {
    console.log("[Server] Startup already in progress, waiting for it");
    return serverStartPromise;
  }

  if (serverInstance) {
    console.log("[Server] Already running, returning existing instance");
    return serverInstance;
  }

  const app = createApp();
  const server = createServer(app);
  serverInstance = server;

  let resolveStart!: (server: Server) => void;
  let rejectStart!: (error: unknown) => void;
  const startPromise = new Promise<Server>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });
  serverStartPromise = startPromise;

  const clearPendingStart = (): void => {
    if (serverStartPromise === startPromise) {
      serverStartPromise = null;
    }
  };
  const handleStartupError = (err: NodeJS.ErrnoException): void => {
    clearPendingStart();
    if (serverInstance === server) {
      serverInstance = null;
    }
    if (err.code === "EADDRINUSE") {
      rejectStart(new Error(`Port ${port} is already in use`));
    } else {
      rejectStart(err);
    }
  };
  server.once("error", handleStartupError);

  try {
    server.listen(port, host, () => {
      server.off("error", handleStartupError);
      server.on("error", (error) => {
        console.error("[Server] Runtime error:", error.message);
      });
      clearPendingStart();
      console.log(
        `[Server] Claude Code CLI provider running at http://${host}:${port}`
      );
      console.log(
        `[Server] OpenAI-compatible endpoint: http://${host}:${port}/v1/chat/completions`
      );
      resolveStart(server);
    });
  } catch (error) {
    server.off("error", handleStartupError);
    clearPendingStart();
    if (serverInstance === server) {
      serverInstance = null;
    }
    rejectStart(error);
  }

  return startPromise;
}

/**
 * Stop the HTTP server
 */
export async function stopServer(): Promise<void> {
  if (serverStopPromise) {
    return serverStopPromise;
  }

  const stopOperation = performStop();
  serverStopPromise = stopOperation;

  try {
    await stopOperation;
  } finally {
    if (serverStopPromise === stopOperation) {
      serverStopPromise = null;
    }
  }
}

async function performStop(): Promise<void> {
  const pendingStart = serverStartPromise;
  if (pendingStart) {
    try {
      await pendingStart;
    } catch {
      return;
    }
  }

  if (!serverInstance) {
    return;
  }

  const server = serverInstance;
  if (!server.listening) {
    serverInstance = null;
    return;
  }

  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (serverInstance === server) {
        serverInstance = null;
      }
      if (err) {
        reject(err);
      } else {
        console.log("[Server] Stopped");
        resolve();
      }
    });
  });
}

/**
 * Get the current server instance
 */
export function getServer(): Server | null {
  return serverInstance;
}
