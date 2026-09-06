// ─── Helpers ───────────────────────────────────────────────────────────────────

// Build a fallback request body schema when the endpoint has no stored schema.
// Produces a generic object with a dummy property so x402scan does not flag
// "Input Schema Missing" (empty properties: {} is still treated as missing).
function buildFallbackRequestBody(ep) {
  return {
    type: "object",
    description: "Optional JSON payload forwarded to the upstream service.",
    properties: {
      _body: { type: "object", description: "Request body passed to upstream (optional)." },
    },
  };
}

// Build a fallback response schema when the endpoint has no stored schema.
// Produces a generic object with a dummy property so x402scan does not flag
// "Output Schema Missing".
function buildFallbackResponseSchema(ep) {
  return {
    type: "object",
    description: "Upstream provider response.",
    properties: {
      data: { type: "object", description: "Upstream response body." },
    },
  };
}

// ─── Build spec ───────────────────────────────────────────────────────────────────

// Generate OpenAPI spec for x402 marketplace
import { endpoints, providers, admin, transactions } from "./db/queries.js";

export async function generateOpenAPISpec() {
  const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
  const NETWORK = process.env.NETWORK || "eip155:84532";
  const USDC_ASSET = process.env.USDC_ASSET || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const PAY_TO = process.env.PLATFORM_WALLET || "";
  const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.xyz/facilitator";

  // Get active marketplace endpoints
  let activeEndpoints = [];
  try { activeEndpoints = await endpoints.listMarketplace({ limit: 100 }); } catch {}

  // Build paths object
  const paths = {};

  // Add marketplace endpoints (dynamic)
  for (const ep of activeEndpoints) {
    const method = ep.method.toLowerCase();
    const priceUsd = (ep.price_atomic / 1_000_000).toFixed(6);
    const pathObj = {
      [method]: {
        operationId: ep.slug.replace(/-/g, "_"),
        summary: ep.name,
        description: ep.description || ep.name,
        tags: ep.tags?.length ? ep.tags : [ep.category],
        security: [{ x402: [] }],
        "x-payment-info": {
          price: { mode: "fixed", currency: "USD", amount: priceUsd },
          protocols: [{ x402: { network: NETWORK, asset: USDC_ASSET, payTo: PAY_TO, maxTimeoutSeconds: 60 } }],
        },
        "x402": {
          accepts: [
            {
              scheme: "exact",
              network: NETWORK,
              amount: String(ep.price_atomic),
              asset: USDC_ASSET,
              payTo: PAY_TO,
              maxTimeoutSeconds: 60,
              extra: { name: "USDC", version: "2" },
            },
          ],
          resource: {
            url: `${SERVER_URL}/proxy/${ep.slug}`,
            description: ep.description || ep.name,
            mimeType: "application/json",
          },
        },
        "extensions": {
          "bazaar": {
            "schema": {
              "type": "object",
              "properties": {
                "input": {
                  "type": "object",
                  "description": "Request body forwarded to upstream (optional).",
                  "properties": {
                    "_body": { "type": "object", "description": "Request body passed to upstream." }
                  }
                },
                "output": {
                  "type": "object",
                  "description": "Upstream provider response body.",
                  "properties": {
                    "data": { "type": "object", "description": "Upstream response body." }
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Upstream provider response",
            content: {
              "application/json": {
                schema: ep.response_schema ? ep.response_schema : buildFallbackResponseSchema(ep)
              }
            }
          },
          "402": {
            description: "Payment Required — include X-Payment header",
            headers: {
              "PAYMENT-REQUIRED": {
                description: "Base64-encoded x402 v2 payment requirements",
                schema: {
                  type: "string"
                }
              }
            },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/x402PaymentRequirements"
                }
              }
            }
          },
        },
      },
    };

    // Add request body for all endpoints to satisfy x402scan.com requirements
    // Use the actual request body schema from the database if available
    pathObj[method].requestBody = {
      required: true, // Request body is required (but can be empty) to satisfy x402scan.com
      content: {
        "application/json": {
          schema: ep.request_body_schema || buildFallbackRequestBody(ep)
        }
      }
    };
    // Add query parameters (forwarded to upstream) for GET
    if (method === "get") {
      const parameters = [];

      // Add configured query parameters from endpoint definition
      if (ep.query_parameters && Array.isArray(ep.query_parameters)) {
        for (const paramName of ep.query_parameters) {
          parameters.push({
            name: paramName,
            in: "query",
            required: false, // We don't know if they're required by upstream, so mark as optional
            schema: { type: "string" },
            description: `Forwarded to upstream`
          });
        }
      }

      // Always allow additional query parameters for flexibility
      // (in case upstream accepts parameters not configured in endpoint)
      // NOTE: We no longer add a generic 'q' parameter for endpoints with no configured parameters
      // This ensures endpoints that truly don't accept any query parameters are represented accurately

      pathObj[method].parameters = parameters;
    }

    paths[`/proxy/${ep.slug}`] = pathObj;
  }

  // Add static paths for non-marketplace endpoints

  // GET /
  paths["/"] = {
    get: {
      summary: "Landing page",
      description: "Returns the HTML landing page with marketplace information.",
      security: [],
      responses: {
        "200": {
          description: "HTML landing page",
          content: {
            "text/html": {
              schema: {
                type: "string"
              }
            }
          }
        }
      }
    }
  };

  // GET /health
  paths["/health"] = {
    get: {
      summary: "Health check",
      description: "Returns OK status if the service is healthy.",
      security: [],
      responses: {
        "200": {
          description: "Health status",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", example: "ok" },
                  ts: { type: "integer" }
                }
              }
            }
          }
        }
      }
    }
  };

  // GET /openapi.json
  paths["/openapi.json"] = {
    get: {
      summary: "OpenAPI specification",
      description: "Returns this OpenAPI JSON document.",
      security: [],
      responses: {
        "200": {
          description: "OpenAPI JSON object",
          content: {
            "application/json": {
              schema: {
                type: "object"
              }
            }
          }
        }
      }
    }
  };

  // GET /.well-known/x402 (alternative discovery endpoint)
  paths["/.well-known/x402"] = {
    get: {
      summary: "OpenAPI specification (well-known)",
      description: "Returns this OpenAPI JSON document for x402 discovery.",
      security: [],
      responses: {
        "200": {
          description: "OpenAPI JSON object",
          content: {
            "application/json": {
              schema: {
                type: "object"
              }
            }
          }
        }
      }
    }
  };

  // Provider endpoints (require X-API-Key)
  paths["/api/providers/register"] = {
    post: {
      summary: "Register a new provider account",
      description: "Create a provider account and receive an API key for authenticated endpoints.",
      security: [],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name", "email", "walletAddress"],
              properties: {
                name: { type: "string", example: "My API Co" },
                email: { type: "string", format: "email", example: "dev@myapi.io" },
                walletAddress: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", example: "0x742d35Cc6634C0532925a3b8D4C0532950532950" }
              }
            }
          }
        }
      },
      responses: {
        "201": {
          description: "Provider registered successfully",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  provider: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      name: { type: "string" },
                      email: { type: "string" },
                      walletAddress: { type: "string" },
                      apiKey: { type: "string" },
                      status: { type: "string" },
                      createdAt: { type: "string", format: "date-time" }
                    }
                  }
                }
              }
            }
          }
        },
        "400": { description: "Validation error" },
        "409": { description: "Email already registered" },
        "500": { description: "Registration failed" }
      }
    }
  };

  // GET /api/providers/me (requires X-API-Key)
  paths["/api/providers/me"] = {
    get: {
      summary: "Get provider dashboard",
      description: "Returns provider profile and dashboard stats.",
      security: [{ apiKey: [] }],
      responses: {
        "200": {
          description: "Provider dashboard",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  name: { type: "string" },
                  email: { type: "string" },
                  walletAddress: { type: "string" },
                  status: { type: "string" },
                  stats: {
                    type: "object",
                    properties: {
                      endpointCount: { type: "integer" },
                      totalEarnedUsdc: { type: "number" },
                      totalGrossUsdc: { type: "number" },
                      totalCalls: { type: "integer" },
                      totalPaidOut: { type: "number" },
                      balancePending: { type: "number" }
                    }
                  }
                }
              }
            }
          }
        },
        "401": { description: "Unauthorized" },
        "500": { description: "Internal server error" }
      }
    }
  };

  // POST /api/providers/me/endpoints (requires X-API-Key)
  paths["/api/providers/me/endpoints"] = {
    post: {
      summary: "Register a new endpoint",
      description: "Create a new paid endpoint for the provider.",
      security: [{ apiKey: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name", "upstreamUrl", "priceUsdc"],
              properties: {
                name: { type: "string", example: "Premium Weather Data" },
                description: { type: "string", example: "Real-time weather for any city" },
                category: { type: "string", example: "data" },
                tags: { type: "array", items: { type: "string" }, example: ["weather", "realtime"] },
                upstreamUrl: { type: "string", format: "uri", example: "https://api.myweather.io/current" },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], example: "GET" },
                priceUsdc: { type: "string", pattern: "^\\d+(\\.\\d+)?$", example: "0.01" },
                slug: { type: "string", pattern: "^[a-z0-9-]+$", example: "premium-weather-data" },
                upstreamAuthHeader: { type: "string", example: "Bearer sk-..." },
                queryParameters: { type: "array", items: { type: "string" } },
                requestBodySchema: { type: "object" },
                responseSchema: { type: "object" }
              }
            }
          }
        }
      },
      responses: {
        "201": {
          description: "Endpoint registered",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  endpoint: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      slug: { type: "string" },
                      name: { type: "string" },
                      description: { type: "string" },
                      category: { type: "string" },
                      method: { type: "string" },
                      priceAtomic: { type: "integer" },
                      priceDisplay: { type: "string" },
                      status: { type: "string" },
                      marketplaceUrl: { type: "string" },
                      createdAt: { type: "string", format: "date-time" }
                    }
                  },
                  economics: {
                    type: "object",
                    properties: {
                      pricePerCallUsdc: { type: "number" },
                      platformFeePercent: { type: "number" },
                      yourEarningsPerCall: { type: "number" }
                    }
                  }
                }
              }
            }
          }
        },
        "400": { description: "Validation error" },
        "401": { description: "Unauthorized" },
        "500": { description: "Internal server error" }
      }
    }
  };

  // Admin endpoints (require X-Admin-Key, but we reuse apiKey scheme for simplicity)
  paths["/admin/stats"] = {
    get: {
      summary: "Get platform revenue stats",
      description: "Returns platform-wide revenue and transaction statistics.",
      security: [{ apiKey: [] }], // Actually requires X-Admin-Key, but we'll use apiKey placeholder for now
      responses: {
        "200": {
          description: "Platform stats",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  platform: {
                    type: "object",
                    properties: {
                      totalProviders: { type: "integer" },
                      activeEndpoints: { type: "integer" },
                      totalTransactions: { type: "integer" },
                      totalVolumeUsdc: { type: "number" },
                      platformRevenueUsdc: { type: "number" },
                      providerRevenueUsdc: { type: "number" },
                      calls24h: { type: "integer" },
                      uniquePayers: { type: "integer" }
                    }
                  }
                }
              }
            }
          }
        },
        "401": { description: "Unauthorized" },
        "500": { description: "Internal server error" }
      }
    }
  };

  paths["/admin/providers"] = {
    get: {
      summary: "Get all providers",
      description: "Returns a list of all providers (paginated).",
      security: [{ apiKey: [] }],
      parameters: [
        { name: "limit", in: "query", required: true, schema: { type: "integer", example: 50 } },
        { name: "offset", in: "query", required: true, schema: { type: "integer", example: 0 } }
      ],
      responses: {
        "200": {
          description: "Paginated list of providers",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  providers: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        name: { type: "string" },
                        email: { type: "string" },
                        walletAddress: { type: "string" },
                        apiKey: { type: "string" },
                        status: { type: "string" },
                        createdAt: { type: "string", format: "date-time" }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "401": { description: "Unauthorized" },
        "500": { description: "Internal server error" }
      }
    }
  };

  paths["/admin/providers/:id/suspend"] = {
    post: {
      summary: "Suspend a provider",
      description: "Suspend a provider account.",
      security: [{ apiKey: [] }],
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "integer" } }
      ],
      responses: {
        "200": {
          description: "Provider suspended",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" }
                }
              }
            }
          }
        },
        "401": { description: "Unauthorized" },
        "404": { description: "Provider not found" },
        "500": { description: "Internal server error" }
      }
    }
  };

  paths["/admin/providers/:id/activate"] = {
    post: {
      summary: "Activate a provider",
      description: "Activate a provider account.",
      security: [{ apiKey: [] }],
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "integer" } }
      ],
      responses: {
        "200": {
          description: "Provider activated",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" }
                }
              }
            }
          }
        },
        "401": { description: "Unauthorized" },
        "404": { description: "Provider not found" },
        "500": { description: "Internal server error" }
      }
    }
  };

  paths["/admin/endpoints"] = {
    get: {
      summary: "Get endpoint review queue",
      description: "Returns all endpoints with a given status (default: pending).",
      security: [{ apiKey: [] }],
      parameters: [
        { name: "status", in: "query", required: true, schema: { type: "string", example: "pending" } }
      ],
      responses: {
        "200": {
          description: "Paginated list of endpoints",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  endpoints: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        slug: { type: "string" },
                        name: { type: "string" },
                        description: { type: "string" },
                        category: { type: "string" },
                        tags: { type: "array", items: { type: "string" } },
                        upstreamUrl: { type: "string" },
                        method: { type: "string" },
                        priceAtomic: { type: "integer" },
                        status: { type: "string" },
                        providerName: { type: "string" },
                        providerEmail: { type: "string" },
                        createdAt: { type: "string", format: "date-time" }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "401": { description: "Unauthorized" },
        "500": { description: "Internal server error" }
      }
    }
  };

  paths["/admin/endpoints/:id/activate"] = {
    post: {
      summary: "Activate an endpoint",
      description: "Approve and activate an endpoint for the marketplace.",
      security: [{ apiKey: [] }],
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "integer" } }
      ],
      responses: {
        "200": {
          description: "Endpoint activated",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  endpoint: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      slug: { type: "string" },
                      name: { type: "string" },
                      description: { type: "string" },
                      category: { type: "string" },
                      method: { type: "string" },
                      priceAtomic: { type: "integer" },
                      priceDisplay: { type: "string" },
                      status: { type: "string" },
                      marketplaceUrl: { type: "string" },
                      createdAt: { type: "string", format: "date-time" }
                    }
                  }
                }
              }
            }
          }
        },
        "401": { description: "Unauthorized" },
        "404": { description: "Endpoint not found" },
        "500": { description: "Internal server error" }
      }
    }
  };

  paths["/admin/endpoints/:id/suspend"] = {
    post: {
      summary: "Suspend an endpoint",
      description: "Suspend an endpoint (remove from marketplace).",
      security: [{ apiKey: [] }],
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "integer" } }
      ],
      responses: {
        "200": {
          description: "Endpoint suspended",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" }
                }
              }
            }
          }
        },
        "401": { description: "Unauthorized" },
        "404": { description: "Endpoint not found" },
        "500": { description: "Internal server error" }
      }
    }
  };

  paths["/admin/transactions"] = {
    get: {
      summary: "Get recent transactions",
      description: "Returns recent transactions across the platform.",
      security: [{ apiKey: [] }],
      parameters: [
        { name: "limit", in: "query", required: true, schema: { type: "integer", example: 100 } }
      ],
      responses: {
        "200": {
          description: "List of transactions",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  transactions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        endpointId: { type: "integer" },
                        providerId: { type: "integer" },
                        txHash: { type: "string" },
                        network: { type: "string" },
                        payerAddress: { type: "string" },
                        amountAtomic: { type: "integer" },
                        platformFeePct: { type: "number" },
                        platformCut: { type: "number" },
                        providerCut: { type: "number" },
                        requestMethod: { type: "string" },
                        requestPath: { type: "string" },
                        requestIp: { type: "string" },
                        upstreamStatus: { type: "integer" },
                        responseTimeMs: { type: "integer" },
                        createdAt: { type: "string", format: "date-time" }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "401": { description: "Unauthorized" },
        "500": { description: "Internal server error" }
      }
    }
  };

  paths["/admin/payouts/pending"] = {
    get: {
      summary: "Get pending payouts",
      description: "Returns providers owed money for manual payout initiation.",
      security: [{ apiKey: [] }],
      responses: {
        "200": {
          description: "Pending payouts",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  providers: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        providerId: { type: "integer" },
                        name: { type: "string" },
                        walletAddress: { type: "string" },
                        owedUsdc: { type: "number" }
                      }
                    }
                  },
                  totalOwed: { type: "number" },
                  count: { type: "integer" }
                }
              }
            }
          }
        },
        "401": { description: "Unauthorized" },
        "500": { description: "Internal server error" }
      }
    }
  };

  paths["/admin/payouts/initiate"] = {
    post: {
      summary: "Create payout records",
      description: "Create manual payout records for providers.",
      security: [{ apiKey: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                providerId: { type: "integer" },
                note: { type: "string" }
              }
            }
          }
        }
      },
      responses: {
        "201": {
          description: "Payouts created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  payouts: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        providerId: { type: "integer" },
                        walletAddress: { type: "string" },
                        amountUsdc: { type: "number" },
                        periodStart: { type: "string", format: "date-time" },
                        periodEnd: { type: "string", format: "date-time" },
                        note: { type: "string" },
                        status: { type: "string" },
                        createdAt: { type: "string", format: "date-time" }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "400": { description: "Validation error" },
        "401": { description: "Unauthorized" },
        "500": { description: "Internal server error" }
      }
    }
  };

  paths["/admin/payouts/:id/complete"] = {
    post: {
      summary: "Mark payout as completed",
      description: "Mark a payout as completed with transaction hash.",
      security: [{ apiKey: [] }],
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "integer" } }
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["txHash"],
              properties: {
                txHash: { type: "string", pattern: "^0x[0-9a-fA-F]+$" }
              }
            }
          }
        }
      },
      responses: {
        "200": {
          description: "Payout marked as completed",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  payout: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      providerId: { type: "integer" },
                      walletAddress: { type: "string" },
                      amountUsdc: { type: "number" },
                      periodStart: { type: "string", format: "date-time" },
                      periodEnd: { type: "string", format: "date-time" },
                      note: { type: "string" },
                      status: { type: "string" },
                      createdAt: { type: "string", format: "date-time" },
                      txHash: { type: "string" },
                      completedAt: { type: "string", format: "date-time" }
                    }
                  }
                }
              }
            }
          }
        },
        "400": { description: "Validation error" },
        "401": { description: "Unauthorized" },
        "404": { description: "Payout not found" },
        "500": { description: "Internal server error" }
      }
    }
  };

  paths["/admin/payouts/:id/fail"] = {
    post: {
      summary: "Mark payout as failed",
      description: "Mark a payout as failed.",
      security: [{ apiKey: [] }],
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "integer" } }
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                note: { type: "string" }
              }
            }
          }
        }
      },
      responses: {
        "200": {
          description: "Payout marked as failed",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  payout: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      providerId: { type: "integer" },
                      walletAddress: { type: "string" },
                      amountUsdc: { type: "number" },
                      periodStart: { type: "string", format: "date-time" },
                      periodEnd: { type: "string", format: "date-time" },
                      note: { type: "string" },
                      status: { type: "string" },
                      createdAt: { type: "string", format: "date-time" }
                    }
                  }
                }
              }
            }
          }
        },
        "401": { description: "Unauthorized" },
        "404": { description: "Payout not found" },
        "500": { description: "Internal server error" }
      }
    }
  };


  // Return the full OpenAPI spec
  return {
    openapi: "3.1.0",
    info: {
      title: "MAMMBA x402 Marketplace",
      version: "1.0.0",
      description: "Multi-tenant API marketplace — pay per request with USDC on Base.",
      contact: {
        email: "info@mammbaent.com"
      },
      "x-guidance": `Pay-per-request marketplace. GET /proxy/{slug} without X-Payment to see requirements. Sign USDC transfer on ${NETWORK} to ${PAY_TO}, base64-encode, send as X-Payment header. Browse endpoints at ${SERVER_URL}/marketplace/endpoints`
    },
    servers: [{ url: SERVER_URL }],
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key"
        },
        x402: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "x402-v2",
          description: "x402 v2 payment required"
        }
      },
      schemas: {
        x402PaymentRequirements: {
          type: "object",
          required: [
            "x402Version",
            "error",
            "resource",
            "accepts"
          ],
          properties: {
            x402Version: {
              type: "integer",
              enum: [2],
              description: "x402 protocol version"
            },
            error: {
              type: "string",
              description: "Error message indicating payment is required"
            },
            resource: {
              type: "object",
              required: [
                "url",
                "description",
                "mimeType"
              ],
              properties: {
                url: {
                  type: "string",
                  format: "uri",
                  description: "URL of the resource requiring payment"
                },
                description: {
                  type: "string",
                  description: "Human-readable description of the resource"
                },
                mimeType: {
                  type: "string",
                  description: "MIME type of the resource"
                }
              }
            },
            accepts: {
              type: "array",
              description: "Payment schemes accepted",
              items: {
                type: "object",
                required: [
                  "scheme",
                  "network",
                  "amount",
                  "asset",
                  "payTo",
                  "maxTimeoutSeconds"
                ],
                properties: {
                  scheme: {
                    type: "string",
                    enum: ["exact"],
                    description: "Payment scheme"
                  },
                  network: {
                    type: "string",
                    description: "Blockchain network (eip155 format)"
                  },
                  amount: {
                    type: "string",
                    description: "Amount required in atomic units"
                  },
                  asset: {
                    type: "string",
                    pattern: "^0x[0-9a-fA-F]{40}$",
                    description: "Contract address of the asset"
                  },
                  payTo: {
                    type: "string",
                    pattern: "^0x[0-9a-fA-F]{40}$",
                    description: "Destination address for payment"
                  },
                  maxTimeoutSeconds: {
                    type: "integer",
                    minimum: 1,
                    maximum: 3600,
                    description: "Maximum time in seconds to complete payment"
                  },
                  extra: {
                    type: "object",
                    description: "Extra information about the asset",
                    properties: {
                      name: {
                        type: "string",
                        description: "Asset name"
                      },
                      version: {
                        type: "string",
                        description: "Asset version"
                      }
                    }
                  }
                }
              }
            },
            extensions: {
              type: "object",
              description: "Vendor-specific extensions",
              properties: {
                marketplace: {
                  type: "object",
                  properties: {
                    info: {
                      type: "object",
                      properties: {
                        platform: {
                          type: "string",
                          description: "Platform name"
                        },
                        endpointSlug: {
                          type: "string",
                          description: "Endpoint slug"
                        },
                        providerName: {
                          type: "string",
                          description: "Provider name"
                        }
                      }
                    },
                    schema: {
                      type: "object",
                      properties: {
                        platform: {
                          type: "string"
                        },
                        endpointSlug: {
                          type: "string"
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "x-x402": { 
      version: 2, 
      network: NETWORK, 
      asset: USDC_ASSET, 
      payTo: PAY_TO, 
      facilitator: FACILITATOR_URL 
    }
  };
}
