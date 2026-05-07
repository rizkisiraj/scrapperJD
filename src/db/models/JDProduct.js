'use strict';

const mongoose = require('mongoose');

const jdProductSchema = new mongoose.Schema(
  {
    // Cross-region join key — jdProductId minus the "jd_" prefix (e.g. "398846-31")
    productCode: { type: String, required: true, unique: true },

    title: { type: String, required: true },

    // Brand name, e.g. "Nike", "adidas"
    vendor: { type: String },

    // Amplience CDN URL
    imageUrl: { type: String },

    // "Men", "Women", "Kids"
    gender: { type: String },

    // "Footwear", "Clothing", etc.
    productType: { type: String },
  },
  {
    // Automatically adds createdAt and updatedAt — useful for debugging stale records
    timestamps: true,
  },
);

module.exports = mongoose.model('JDProduct', jdProductSchema);
