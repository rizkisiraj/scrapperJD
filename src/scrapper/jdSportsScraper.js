'use strict';

// Main scraper entry point.
// Exposes a single run(region) function — the scheduler calls this.
//
// Routing:
//   MY / SG  →  Algolia adapter  (Shopify-backed product index)
//   ID       →  Unbxd adapter    (search.unbxd.io category API)
//
// Each adapter paginates all collections, filters to valid parent products,
// maps raw API fields → our schema, then delegates writes to repository.js.
//
// eslint-disable-next-line max-len
// Note: no-restricted-syntax and no-await-in-loop are disabled at file level because
// paginated scraping is inherently sequential — each page response tells us
// whether to continue, so parallel fetching is not safe here.
/* eslint-disable no-restricted-syntax, no-await-in-loop */

const { upsertProduct, upsertStock, updateStockSizes } = require('../db/repository');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Unbxd (ID) constants
// ---------------------------------------------------------------------------

// eslint-disable-next-line max-len
const UNBXD_BASE_URL = 'https://search.unbxd.io/7c34c80de1987a640ab3e748fe520e20/ss-unbxd-prod-jdsports7041644398343/category';
const UNBXD_ROWS = 36;

// Each category is a separate paginated request. Products appear in multiple
// categories — duplicate upserts are harmless and idempotent.
const UNBXD_CATEGORIES = [
  'JDSport>Men>Footwear',
  'JDSport>Women>Footwear',
];

// ---------------------------------------------------------------------------
// Algolia constants
// ---------------------------------------------------------------------------

// MY and SG each have their own Algolia application (different app IDs/keys).
const ALGOLIA_MY = {
  appId: '4D2A6Y0IG5',
  apiKey: '3f7a46016528bb98e61415eac00f245e',
  index: 'JDMY_products',
  currency: 'MYR',
  // MY exposes variants_inventory_count directly on the hit
  getInventoryCount: (hit) => hit.variants_inventory_count ?? 0,
  getInStock: (hit) => (hit.variants_inventory_count ?? 0) > 0,
  // Filter to in-stock products only
  stockFilter: 'variants_inventory_count > 0',
};

const ALGOLIA_SG = {
  appId: 'SR9ZJJRPEO',
  apiKey: 'b062db9b2eec723789e79bff79ff80ff',
  index: 'JDSG_products',
  currency: 'SGD',
  // SG does not have variants_inventory_count — stock lives in meta.custom
  getInventoryCount: (hit) => hit.meta?.custom?.metafield_total_product_qty ?? 0,
  getInStock: (hit) => hit.inventory_available === true,
  // SG has no filterable stock attribute — filter client-side via getInStock instead
  stockFilter: null,
};

const ALGOLIA_COLLECTIONS = ['men-footwear', 'women-footwear'];
const ALGOLIA_HITS_PER_PAGE = 48;

// ---------------------------------------------------------------------------
// Shopify Storefront constants (size enrichment only)
// ---------------------------------------------------------------------------

// Token is public (embedded in storefront JS) — Shopify Storefront tokens are read-only
const SHOPIFY_MY = {
  endpoint: 'https://e757de-f4.myshopify.com/api/2024-01/graphql',
  token: '3780a97e1ccd5fc24eb8efcdb10e951b',
  origin: 'https://www.jdsports.my',
};

const SHOPIFY_SG = {
  endpoint: 'https://19a223-e7.myshopify.com/api/2024-01/graphql',
  token: 'ae0e52f9f4aad6c27e229893156524d1',
  origin: 'https://www.jdsports.sg',
};

const SHOPIFY_PRODUCTS_PER_PAGE = 50;

// Minimal query — only tags and variants needed for size enrichment
const SHOPIFY_SIZES_QUERY = `
  query getSizes($cursor: String) {
    products(first: ${SHOPIFY_PRODUCTS_PER_PAGE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          tags
          variants(first: 30) {
            edges { node { title availableForSale } }
          }
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Unbxd adapter
// ---------------------------------------------------------------------------

/**
 * Fetch one page from the Unbxd category API.
 * Returns the `response` object: { numberOfProducts, products[] }
 */
const fetchUnbxdPage = async (category, start) => {
  const params = new URLSearchParams({
    version: 'v2',
    p: `categoryPath:"${category}"`,
    filter: 'availability:true',
    facet: 'false',
    pagetype: 'boolean',
    start: String(start),
    rows: String(UNBXD_ROWS),
  });

  const res = await fetch(`${UNBXD_BASE_URL}?${params.toString()}`);

  if (!res.ok) {
    throw new Error(`Unbxd HTTP ${res.status} for category "${category}" start=${start}`);
  }

  const body = await res.json();
  return body.response;
};

/**
 * Map one Unbxd parent product hit → { productData, stockData }.
 *
 * Field notes:
 *   - jdProductId: "jd_U530CSF" → strip "jd_" prefix for productCode
 *   - product_brand: array, take first element
 *   - imageUrl: array, take first element
 *   - promoPrice / regPrice: if different, item is on sale
 *   - jd_multi_size may be absent on some products — default to []
 */
const mapUnbxdProduct = (hit) => {
  const productCode = hit.jdProductId.replace(/^jd_/, '');
  const isOnSale = hit.promoPrice !== hit.regPrice;

  const productData = {
    productCode,
    title: hit.title,
    vendor: Array.isArray(hit.product_brand) ? hit.product_brand[0] : (hit.product_brand || ''),
    imageUrl: Array.isArray(hit.imageUrl) ? hit.imageUrl[0] : (hit.imageUrl || ''),
    gender: Array.isArray(hit.jd_gender) ? hit.jd_gender[0] : (hit.jd_gender || ''),
    productType: Array.isArray(hit.jd_product_category)
      ? hit.jd_product_category[0]
      : 'Footwear',
  };

  const stockData = {
    productCode,
    region: 'ID',
    sizesAvailable: hit.jd_in_stock_sizes || [],
    sizesTotal: hit.jd_multi_size || [],
    inStock: hit.availability === 'true' || hit.availability === true,
    totalStock: hit.totalStock || 0,
    price: hit.promoPrice,
    originalPrice: isOnSale ? hit.regPrice : null,
    isOnSale,
    currency: 'IDR',
  };

  return { productData, stockData };
};

/**
 * Scrape all Unbxd footwear categories for JD Indonesia.
 * Paginates each category until all products are fetched.
 */
const scrapeID = async () => {
  let totalParents = 0;
  let totalUpserted = 0;

  for (const category of UNBXD_CATEGORIES) {
    logger.info({ category }, 'starting Unbxd category');

    let start = 0;
    let numberOfProducts = null;

    do {
      const response = await fetchUnbxdPage(category, start);
      const { products, numberOfProducts: total } = response;

      if (numberOfProducts === null) {
        numberOfProducts = total;
        logger.info({ category, numberOfProducts }, 'category product count');
      }

      // Only scrape parent products; variants share the same productCode and
      // would overwrite stock data with incomplete/duplicate information.
      const parents = products.filter((hit) => hit.parent_unbxd === true);

      logger.info(
        {
          category,
          start,
          fetched: products.length,
          parents: parents.length,
        },
        'page',
      );

      for (const hit of parents) {
        const { productData, stockData } = mapUnbxdProduct(hit);
        await upsertProduct(productData);
        await upsertStock(stockData);
        totalUpserted += 1;
      }

      totalParents += parents.length;
      start += UNBXD_ROWS;
    } while (start < numberOfProducts);

    logger.info({ category }, 'category done');
  }

  logger.info({ totalParents, totalUpserted }, 'ID scrape complete');
};

// ---------------------------------------------------------------------------
// Algolia adapter
// ---------------------------------------------------------------------------

/**
 * POST to the Algolia single-index query endpoint.
 * Returns the full Algolia response: { hits, nbHits, nbPages, page, ... }
 *
 * We use `distinct: true` so Algolia deduplicates to one hit per product
 * handle (otherwise each size variant is a separate hit).
 *
 * `filters` narrows to a single collection for focused, browsable pages.
 */
const fetchAlgoliaPage = async (appId, apiKey, index, collection, page, stockFilter) => {
  const host = `${appId.toLowerCase()}-dsn.algolia.net`;
  const url = `https://${host}/1/indexes/${index}/query`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-algolia-api-key': apiKey,
      'x-algolia-application-id': appId,
    },
    body: JSON.stringify({
      hitsPerPage: ALGOLIA_HITS_PER_PAGE,
      page,
      // Keep only products with stock — SG has no filterable stock attribute so stockFilter is null
      filters: stockFilter
        ? `collections:${collection} AND ${stockFilter}`
        : `collections:${collection}`,
      distinct: true,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Algolia HTTP ${res.status} for ${index} collection=${collection} page=${page}`,
    );
  }

  return res.json();
};

/**
 * Extract the JD style code from a product image URL.
 * Both Shopify CDN and Amplience CDN embed it as jd_<CODE>_ in the path.
 *
 *   Shopify:   .../files/jd_CD6404-106_a.jpg  →  CD6404-106
 *   Amplience: .../jd_U530CSF_al              →  U530CSF
 *
 * This is the real cross-region join key — it matches Unbxd's jdProductId
 * after stripping the "jd_" prefix.
 */
const extractCodeFromImage = (imageUrl) => {
  if (!imageUrl) return null;
  const match = imageUrl.match(/jd_([A-Z0-9-]+)_/i);
  return match ? match[1] : null;
};

/**
 * Map one Algolia hit → { productData, stockData }.
 *
 * Field notes:
 *   - productCode: extracted from image URL (cross-region key, matches Unbxd)
 *     NOT metafield_product_code — that's a Shopify-internal numeric ID
 *   - metafield_size_map: array of { euSize, ukSize, usMens, usWomens }
 *     We store UK sizes as sizesTotal (JD Sports is a UK brand)
 *   - sizesAvailable: Algolia returns one variant per product (distinct=true),
 *     so per-size availability isn't available. Store empty — inStock/totalStock
 *     is sufficient for the heatmap use case.
 *   - isOnSale: checked via metafield_sale_toggle OR compare_at_price > price
 */
const mapAlgoliaProduct = (hit, region, config) => {
  const { currency, getInventoryCount, getInStock } = config;
  const imageUrl = hit.product_image || hit.image || '';
  const productCode = extractCodeFromImage(imageUrl);
  const saleToggle = hit.meta.custom.metafield_sale_toggle === 'true';
  const compareAtPrice = hit.variants_compare_at_price_max;
  const isOnSale = saleToggle || (compareAtPrice != null && compareAtPrice > hit.price);

  const sizeMap = hit.meta.custom.metafield_size_map || [];
  const sizesTotal = sizeMap.map((s) => s.ukSize).filter(Boolean);

  const productData = {
    productCode,
    title: hit.title,
    vendor: hit.vendor || '',
    imageUrl,
    gender: Array.isArray(hit.meta.custom.metafield_gender)
      ? hit.meta.custom.metafield_gender[0]
      : '',
    productType: hit.product_type || 'Footwear',
  };

  const stockData = {
    productCode,
    region,
    sizesAvailable: [],
    sizesTotal,
    inStock: getInStock(hit),
    totalStock: getInventoryCount(hit),
    price: hit.price,
    originalPrice: isOnSale ? compareAtPrice : null,
    isOnSale,
    currency,
  };

  return { productData, stockData };
};

/**
 * Scrape all Algolia collections for a given region config.
 * Shared by scrapeMY and scrapeSG — only the credentials, index, and currency differ.
 */
const scrapeAlgolia = async (region, config) => {
  const {
    appId, apiKey, index, currency,
  } = config;
  let totalHits = 0;
  let totalUpserted = 0;

  for (const collection of ALGOLIA_COLLECTIONS) {
    logger.info({ region, collection }, 'starting Algolia collection');

    let page = 0;
    let nbPages = null;
    let shouldContinue = true;

    while (shouldContinue) {
      const data = await fetchAlgoliaPage(appId, apiKey, index, collection, page, config.stockFilter);

      if (nbPages === null) {
        nbPages = data.nbPages;
        logger.info(
          {
            region,
            collection,
            nbHits: data.nbHits,
            nbPages,
          },
          'collection total',
        );

        // Early exit: zero hits means the index name is likely wrong
        if (data.nbHits === 0) {
          logger.warn({ region, index, collection }, 'zero hits — index name may be wrong');
          shouldContinue = false;
        }
      }

      if (shouldContinue) {
        logger.info(
          {
            region, collection, page, hits: data.hits.length,
          },
          'page',
        );

        for (const hit of data.hits) {
          if (!extractCodeFromImage(hit.product_image || hit.image)) {
            logger.warn({ objectID: hit.objectID }, 'skipping hit: no productCode in image URL');
          } else {
            const { productData, stockData } = mapAlgoliaProduct(hit, region, config);
            await upsertProduct(productData);
            await upsertStock(stockData);
            totalUpserted += 1;
          }
        }

        totalHits += data.hits.length;
        page += 1;
        shouldContinue = page < nbPages;
      }
    }

    logger.info({ region, collection }, 'collection done');
  }

  logger.info({ region, totalHits, totalUpserted }, `${region} scrape complete`);
};

// ---------------------------------------------------------------------------
// Shopify size enrichment adapter
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * POST one page to the Shopify Storefront GraphQL API.
 * Returns the `products` connection object: { pageInfo, edges }
 */
const fetchShopifyPage = async (config, cursor) => {
  const res = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': config.token,
      // Mimic a real storefront browser request — reduces IP-level throttle risk
      'User-Agent': 'Mozilla/5.0 (compatible; JDSportsHeatmap/1.0)',
      'Origin': config.origin,
    },
    body: JSON.stringify({
      query: SHOPIFY_SIZES_QUERY,
      variables: { cursor: cursor || null },
    }),
  });

  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status} for ${config.endpoint} cursor=${cursor}`);
  }

  const body = await res.json();
  if (body.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(body.errors)}`);
  }

  return body.data.products;
};

/**
 * Second-pass size enrichment.
 * Paginates all Shopify products, extracts productCode from the meta__BRAND_REF tag,
 * and patches sizesAvailable / sizesTotal on existing stock records.
 *
 * Runs AFTER scrapeAlgolia so the stock records already exist to be patched.
 * Products that Algolia didn't write (no matching stock record) are silently skipped.
 */
const enrichSizesShopify = async (region, config) => {
  let cursor = null;
  let hasNextPage = true;
  let pageNum = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  while (hasNextPage) {
    const products = await fetchShopifyPage(config, cursor);

    logger.info(
      { region, page: pageNum, fetched: products.edges.length },
      'size enrichment page',
    );

    for (const { node } of products.edges) {
      // productCode is stored in tags as "meta__BRAND_REF:XXXXXX"
      const brandRefTag = node.tags.find((t) => t.startsWith('meta__BRAND_REF:'));
      const productCode = brandRefTag ? brandRefTag.split(':')[1] : null;

      if (!productCode) {
        totalSkipped += 1;
        continue;
      }

      const allVariants = node.variants.edges.map((e) => e.node);
      const sizesTotal = allVariants.map((v) => v.title);
      const sizesAvailable = allVariants.filter((v) => v.availableForSale).map((v) => v.title);

      await updateStockSizes(productCode, region, sizesAvailable, sizesTotal);
      totalUpdated += 1;
    }

    hasNextPage = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;
    pageNum += 1;

    // Polite delay — Shopify Storefront API is cost-throttled per second
    if (hasNextPage) await sleep(400);
  }

  logger.info({ region, totalUpdated, totalSkipped }, `${region} size enrichment complete`);
};

const scrapeMY = async () => {
  await scrapeAlgolia('MY', ALGOLIA_MY);      // fast — metadata + stock booleans
  await enrichSizesShopify('MY', SHOPIFY_MY); // second pass — fills in sizesAvailable/sizesTotal
};
const scrapeSG = async () => {
  await scrapeAlgolia('SG', ALGOLIA_SG);
  await enrichSizesShopify('SG', SHOPIFY_SG);
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Entry point for the scheduler and CLI.
 * Connects to the DB, runs the correct adapter, then disconnects.
 */
const run = async (region) => {
  /* eslint-disable global-require */
  require('dotenv').config();
  const { connect } = require('../db/connection');
  const mongoose = require('mongoose');
  /* eslint-enable global-require */

  logger.info({ region }, 'scrape started');
  await connect();

  switch (region) {
    case 'ID':
      await scrapeID();
      break;
    case 'MY':
      await scrapeMY();
      break;
    case 'SG':
      await scrapeSG();
      break;
    default:
      throw new Error(`Unknown region: ${region}. Must be ID, MY, or SG.`);
  }

  await mongoose.disconnect();
  logger.info({ region }, 'scrape finished');
};

module.exports = { run };

// CLI entry point: node src/scrapper/jdSportsScraper.js [ID|MY|SG]
if (require.main === module) {
  const [, , region = 'SG'] = process.argv;
  run(region).catch((err) => {
    logger.error({ err }, 'scrape failed');
    process.exit(1);
  });
}
