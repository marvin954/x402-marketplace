import express from "express";
import pg from "pg";

const router = express.Router();

function getConnectionString() {
  // Construct connection string from individual POSTGRES variables if needed
  let connectionString = process.env.storage_DATABASE_URL || process.env.DATABASE_URL || process.env.x4_DATABASE_URL;

  // If we have individual POSTGRES variables but no DATABASE_URL, construct it
  if (!connectionString &&
      process.env.POSTGRES_USER &&
      process.env.POSTGRES_PASSWORD &&
      process.env.POSTGRES_DB) {
    const host = process.env.POSTGRES_HOST || 'localhost';
    const port = process.env.POSTGRES_PORT || '5432';
    connectionString = `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${host}:${port}/${process.env.POSTGRES_DB}`;
    console.log('[seed] Constructed connectionString from POSTGRES vars:', connectionString);
  }

  if (!connectionString) {
    console.log('[seed] No connection string found. Env vars:');
    console.log('[seed]   storage_DATABASE_URL:', !!process.env.storage_DATABASE_URL);
    console.log('[seed]   DATABASE_URL:', !!process.env.DATABASE_URL);
    console.log('[seed]   x4_DATABASE_URL:', !!process.env.x4_DATABASE_URL);
    console.log('[seed]   POSTGRES_USER:', !!process.env.POSTGRES_USER);
    console.log('[seed]   POSTGRES_PASSWORD:', !!process.env.POSTGRES_PASSWORD);
    console.log('[seed]   POSTGRES_DB:', !!process.env.POSTGRES_DB);
    throw new Error("DATABASE_URL is not set in Vercel env vars.");
  }

  return connectionString;
}

router.get("/", async (req, res) => {
  // Check for the seed token in the query string or header
  const token = req.query.token || req.headers["x-seed-token"];
  const expectedToken = process.env.SEED_TOKEN;

  if (!token || token !== expectedToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const pool = new pg.Pool({ connectionString: getConnectionString() });
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const DEMO_PROVIDERS = [
        {
          name: "WeatherAPI Pro",
          email: "weather@demo.io",
          wallet: "0x1111111111111111111111111111111111111111",
          endpoints: [
            {
              slug: "weather-current",
              name: "Current Weather",
              description: "Real-time weather data for any city. Returns temp, humidity, wind, and conditions.",
              category: "data",
              tags: ["weather", "iot", "realtime"],
              upstreamUrl: "https://wttr.in/",
              queryParameters: ["format"],
              method: "GET",
              priceAtomic: 5000,
            },
          ],
        },
        {
          name: "FinData Labs",
          email: "findata@demo.io",
          wallet: "0x2222222222222222222222222222222222222222",
          endpoints: [
            {
              slug: "crypto-prices",
              name: "Crypto Price Feed",
              description: "Live BTC, ETH, SOL prices via CoinGecko. Sub-cent per call.",
              category: "finance",
              tags: ["crypto", "prices", "defi"],
              upstreamUrl: "https://api.coingecko.com/api/v3/simple/price",
              queryParameters: ["ids", "vs_currencies"],
              method: "GET",
              priceAtomic: 3000,
            },
            {
              slug: "exchange-rates",
              name: "FX Exchange Rates",
              description: "Live foreign exchange rates for 170+ currencies.",
              category: "finance",
              tags: ["forex", "currency", "exchange"],
              upstreamUrl: "https://open.er-api.com/v6/latest",
              queryParameters: ["base"],
              method: "GET",
              priceAtomic: 2000,
            },
          ],
        },
        {
          name: "DevUtils",
          email: "devutils@demo.io",
          wallet: "0x3333333333333333333333333333333333333333",
          endpoints: [
            {
              slug: "ip-geolocation",
              name: "IP Geolocation",
              description: "Geolocate any IP address — country, city, ISP, timezone.",
              category: "utilities",
              tags: ["ip", "geo", "security"],
              upstreamUrl: "https://ipinfo.io/",
              queryParameters: ["ip"],
              method: "GET",
              priceAtomic: 4000,
            },
            {
              slug: "http-echo",
              name: "HTTP Echo",
              description: "Returns your request headers, body, and params back as JSON. Great for agent testing.",
              category: "utilities",
              tags: ["echo", "debug", "testing"],
              upstreamUrl: "https://httpbin.org/get",
              queryParameters: ["q"],
              method: "GET",
              priceAtomic: 1000,
            },
          ],
        },
      ];

      for (const p of DEMO_PROVIDERS) {
        // Upsert provider
        const { rows: [provider] } = await client.query(
          `INSERT INTO providers (name, email, wallet_address)
           VALUES ($1,$2,$3)
           ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name
           RETURNING id, api_key`,
          [p.name, p.email, p.wallet]
        );

        console.log(`  ✓ Provider: ${p.name} (key: ${provider.api_key.slice(0,12)}...)`);

        for (const ep of p.endpoints) {
          // Check slug doesn't exist
          const { rows: existing } = await client.query(
            `SELECT id FROM endpoints WHERE slug=$1`, [ep.slug]
          );
          if (existing.length) {
            console.log(`    · Endpoint '${ep.slug}' already exists — skipping`);
            continue;
          }

          console.log(`Seeding endpoint ${ep.slug} with queryParameters:`, ep.queryParameters);
          console.log(`  Type of queryParameters:`, typeof ep.queryParameters);
          console.log(`  Is Array:`, Array.isArray(ep.queryParameters));
await client.query(
            `INSERT INTO endpoints
               (provider_id, slug, name, description, category, tags, upstream_url, method, price_atomic,
                upstream_auth_header, query_parameters, request_body_schema, response_schema, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active')`,
            [provider.id, ep.slug, ep.name, ep.description, ep.category,
             ep.tags, ep.upstreamUrl, ep.method, ep.priceAtomic,
             null /* upstream_auth_header */, ep.queryParameters /* query_parameters */, null /* request_body_schema */, '{}' /* response_schema */]
          );
          console.log(`    · Endpoint: ${ep.name} → /proxy/${ep.slug} (${ep.priceAtomic/1e6} USDC)`);
        }
      }

      await client.query("COMMIT");
      res.json({ status: "success", message: "Database seeded successfully" });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
      await pool.end();
    }
  } catch (err) {
    console.error("[seed] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;