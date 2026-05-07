'use strict';

const mongoose = require('mongoose');

const jdRegionStockSchema = new mongoose.Schema(
  {
    // FK to JDProduct — same productCode format (e.g. "398846-31")
    productCode: { type: String, required: true },

    // "MY", "ID", "SG"
    region: { type: String, required: true, enum: ['MY', 'ID', 'SG'] },

    // Sizes currently in stock (e.g. ["8", "9", "10"])
    sizesAvailable: { type: [String], default: [] },

    // All sizes the product carries, regardless of stock
    sizesTotal: { type: [String], default: [] },

    inStock: { type: Boolean, default: false },

    // Total units available — Unbxd exposes this; Algolia does not (will be 0)
    totalStock: { type: Number, default: 0 },

    // Current selling price
    price: { type: Number },

    // Pre-sale price — null when the product is not on sale
    originalPrice: { type: Number, default: null },

    isOnSale: { type: Boolean, default: false },

    // "MYR", "IDR", "SGD"
    currency: { type: String },

    scrapedAt: { type: Date, default: Date.now },
  },
);

// Enforce one stock record per (product, region) pair.
// The scraper upserts on this compound key every run.
jdRegionStockSchema.index({ productCode: 1, region: 1 }, { unique: true });

module.exports = mongoose.model('JDRegionStock', jdRegionStockSchema);
