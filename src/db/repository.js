'use strict';

const JDProduct = require('./models/JDProduct');
const JDRegionStock = require('./models/JDRegionStock');
const logger = require('../config/logger');

/**
 * Upsert product metadata by productCode.
 * Safe to call on every scrape run — only updates if something actually changed.
 */
const upsertProduct = async (productData) => {
  const { productCode, ...fields } = productData;

  const result = await JDProduct.findOneAndUpdate(
    { productCode },
    { $set: fields },
    { upsert: true, new: true },
  );

  logger.debug({ productCode }, 'upserted product');
  return result;
};

/**
 * Upsert per-region stock snapshot by (productCode, region).
 * Called on every scrape run — this record reflects current availability.
 */
const upsertStock = async (stockData) => {
  const { productCode, region, ...fields } = stockData;

  // Always refresh scrapedAt so we know when this snapshot was last written
  const result = await JDRegionStock.findOneAndUpdate(
    { productCode, region },
    { $set: { ...fields, scrapedAt: new Date() } },
    { upsert: true, new: true },
  );

  logger.debug({ productCode, region }, 'upserted stock');
  return result;
};

/**
 * Patch only sizesAvailable and sizesTotal on an existing stock record.
 * Called after the Shopify GraphQL size enrichment pass — does not touch
 * price, inStock, or any other fields written by the main Algolia scrape.
 */
const updateStockSizes = async (productCode, region, sizesAvailable, sizesTotal) => {
  const result = await JDRegionStock.findOneAndUpdate(
    { productCode, region },
    { $set: { sizesAvailable, sizesTotal } },
    { new: true },
  );

  logger.debug({ productCode, region }, 'updated sizes');
  return result;
};

module.exports = { upsertProduct, upsertStock, updateStockSizes };

// Smoke test: node src/db/repository.js
if (require.main === module) {
  /* eslint-disable global-require */
  require('dotenv').config();
  const { connect } = require('./connection');
  const mongoose = require('mongoose');
  /* eslint-enable global-require */

  const run = async () => {
    await connect();

    const product = await upsertProduct({
      productCode: 'TEST-001',
      title: 'Test Sneaker',
      vendor: 'TestBrand',
      imageUrl: 'https://example.com/img.jpg',
      gender: 'Men',
      productType: 'Footwear',
    });
    logger.info({ productCode: product.productCode }, 'product upserted');

    const stock = await upsertStock({
      productCode: 'TEST-001',
      region: 'MY',
      sizesAvailable: ['8', '9'],
      sizesTotal: ['7', '8', '9', '10'],
      inStock: true,
      totalStock: 5,
      price: 499,
      originalPrice: null,
      isOnSale: false,
      currency: 'MYR',
    });
    logger.info({ productCode: stock.productCode, region: stock.region }, 'stock upserted');

    await mongoose.disconnect();
  };

  run().catch((err) => {
    logger.error({ err }, 'smoke test failed');
    process.exit(1);
  });
}
