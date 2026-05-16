import type { Context, Config } from "@netlify/functions";
import { load } from "cheerio";

// FRED API for SOFR and Brent Crude
const FRED_API_KEY = Netlify.env.get("FRED_API_KEY");
const FRED_BASE_URL = "https://api.stlouisfed.org/fred/series/observations";

// Exchange Rate API
const EXCHANGE_RATE_API_KEY = Netlify.env.get("EXCHANGE_RATE_API_KEY");
const EXCHANGE_RATE_BASE_URL = "https://v6.exchangerate-api.com/v6";

// Data sources for Baltic Dry Index
const BDI_SOURCES = {
  balticDryIndex: "https://balticdryindex.com/",
  tradingEconomics: "https://tradingeconomics.com/commodity/baltic",
};

// Jet Fuel conversion: 42 gallons per barrel
const GALLONS_PER_BARREL = 42;

// ============================================================
// Type Definitions
// ============================================================

interface FredResponse {
  value: number;
  date: string;
  success: true;
}

interface FredError {
  success: false;
  error: string;
}

type FredResult = FredResponse | FredError;

interface BdiResponse {
  value: number;
  source: string;
  success: true;
}

interface BdiError {
  success: false;
  error: string;
}

type BdiResult = BdiResponse | BdiError;

interface FxRatesResponse {
  rates: {
    JPY: number;
    EUR: number;
  };
  success: true;
}

interface FxRatesError {
  success: false;
  error: string;
}

type FxRatesResult = FxRatesResponse | FxRatesError;

// ============================================================
// FRED API Fetcher
// ============================================================

async function fetchFredData(seriesId: string): Promise<FredResult> {
  try {
    const url = `${FRED_BASE_URL}?series_id=${seriesId}&api_key=${FRED_API_KEY}&limit=1&sort_order=desc`;
    const response = await fetch(url);
    const data = await response.json() as any;

    if (data.observations && data.observations.length > 0) {
      const value = parseFloat(data.observations[0].value);
      const date = data.observations[0].date;
      return { value, date, success: true };
    }
    return { success: false, error: "No data returned" };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// ============================================================
// Baltic Dry Index Scrapers
// ============================================================

async function scrapeBDIFromBalticDryIndex(): Promise<BdiResult> {
  try {
    const response = await fetch(BDI_SOURCES.balticDryIndex);
    const html = await response.text();
    const $ = load(html);

    // Look for the main BDI number (4-digit value)
    // BalticDryIndex.com displays it prominently
    let bdiValue: string | null = null;

    // Try multiple selector patterns
    const selectors = [
      'span.bdi-value',
      'div[data-value]',
      'h1',
      'div.value'
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length) {
        const text = element.text().trim().replace(/,/g, '');
        // Check if it matches BDI pattern (3-5 digit number)
        if (/^\d{3,5}$/.test(text)) {
          bdiValue = text;
          break;
        }
      }
    }

    // Fallback: search all spans for BDI-like values
    if (!bdiValue) {
      $('span, div').each((_, el) => {
        const text = $(el).text().trim().replace(/,/g, '');
        if (/^\d{3,5}$/.test(text) && !bdiValue) {
          const value = parseInt(text);
          // BDI typically ranges 1000-5000, filter out unlikely values
          if (value >= 500 && value <= 10000) {
            bdiValue = text;
            return false; // break
          }
        }
      });
    }

    if (bdiValue) {
      return {
        value: parseFloat(bdiValue),
        success: true,
        source: "balticdryindex.com",
      };
    }

    return { success: false, error: "Could not parse BDI value" };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Scraping failed",
    };
  }
}

async function scrapeBDIFromTradingEconomics(): Promise<BdiResult> {
  try {
    const response = await fetch(BDI_SOURCES.tradingEconomics);
    const html = await response.text();
    const $ = load(html);

    // Trading Economics displays the current value
    let bdiValue: string | null = null;

    // Try common patterns
    const selectors = [
      'span[data-test="instrument-price-last"]',
      'h1',
      'span.lastPrice',
      'div.current-value'
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length) {
        const text = element.text().trim().replace(/,/g, '');
        if (/^\d{3,5}(\.\d+)?$/.test(text)) {
          bdiValue = text;
          break;
        }
      }
    }

    // Fallback: find largest numeric value that looks like BDI
    if (!bdiValue) {
      let largestValue = 0;
      let largestText = '';
      
      $('span, div').each((_, el) => {
        const text = $(el).text().trim().replace(/,/g, '');
        if (/^\d{3,5}(\.\d+)?$/.test(text)) {
          const value = parseFloat(text);
          if (value >= 500 && value <= 10000 && value > largestValue) {
            largestValue = value;
            largestText = text;
          }
        }
      });

      if (largestText) {
        bdiValue = largestText;
      }
    }

    if (bdiValue) {
      return {
        value: parseFloat(bdiValue),
        success: true,
        source: "tradingeconomics.com",
      };
    }

    return { success: false, error: "Could not parse BDI value" };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Scraping failed",
    };
  }
}

// Main BDI fetcher with fallback logic
async function fetchBDI(): Promise<BdiResult> {
  // Try primary source first
  let result = await scrapeBDIFromBalticDryIndex();
  if (result.success) return result;

  // Fall back to secondary source
  result = await scrapeBDIFromTradingEconomics();
  if (result.success) return result;

  // Both failed
  return { success: false, error: "All BDI sources failed" };
}

// ============================================================
// FX Rate Fetcher
// ============================================================

async function fetchExchangeRates(
  baseCurrency: string,
  targetCurrencies: string[]
): Promise<FxRatesResult> {
  try {
    const url = `${EXCHANGE_RATE_BASE_URL}/${EXCHANGE_RATE_API_KEY}/latest/${baseCurrency}`;
    const response = await fetch(url);
    const data = await response.json() as any;

    if (data.conversion_rates) {
      return {
        rates: {
          JPY: data.conversion_rates.JPY,
          EUR: data.conversion_rates.EUR,
        },
        success: true,
      };
    }
    return { success: false, error: "No rates returned" };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// ============================================================
// Main Handler
// ============================================================

export default async (req: Request, context: Context) => {
  try {
    // Log environment check
    console.log("=== Function Start ===");
    console.log("FRED_API_KEY set:", !!FRED_API_KEY);
    console.log("EXCHANGE_RATE_API_KEY set:", !!EXCHANGE_RATE_API_KEY);
    
    // Fetch all data in parallel

    const [sofr, brent, jetFuel, bdi, fxRates] = await Promise.all([
      fetchFredData("SOFR"),
      fetchFredData("DCOILBRENTEU"),
      fetchFredData("DJFUELUSGULF"),
      fetchBDI(),
      fetchExchangeRates("USD", ["JPY", "EUR"]),
    ]);

    // Calculate jet fuel per barrel and crack spread
    let jetFuelPerBarrel: number | null = null;
    let crackSpread: number | null = null;

    if (jetFuel.success && brent.success) {
      jetFuelPerBarrel = jetFuel.value * GALLONS_PER_BARREL;
      crackSpread = jetFuelPerBarrel - brent.value;
    }

    const responseBody = {
      timestamp: new Date().toISOString(),
      data: {
        sofr: sofr.success
          ? { value: sofr.value, date: sofr.date }
          : { error: sofr.error },
        brent: brent.success
          ? { value: brent.value, date: brent.date, unit: "$/bbl" }
          : { error: brent.error },
        jetFuel: jetFuel.success
          ? { value: jetFuel.value, date: jetFuel.date, unit: "$/gallon" }
          : { error: jetFuel.error },
        jetFuelPerBarrel: jetFuelPerBarrel
          ? { value: jetFuelPerBarrel, unit: "$/bbl" }
          : { error: "Cannot calculate" },
        crackSpread: crackSpread
          ? { value: crackSpread, unit: "$/bbl" }
          : { error: "Cannot calculate" },
        balticDryIndex: bdi.success
          ? { value: bdi.value, source: bdi.source }
          : { error: bdi.error },
        fxRates: fxRates.success
          ? { usdJpy: fxRates.rates.JPY, eurUsd: fxRates.rates.EUR }
          : { error: fxRates.error },
      },
    };

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error in get-market-data function:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to fetch market data",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};

export const config: Config = {
  path: "/api/market-data",
};
