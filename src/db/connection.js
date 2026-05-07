'use strict';

const mongoose = require('mongoose');
const logger = require('../config/logger');

const connect = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    logger.info({ uri: process.env.MONGO_URI }, 'MongoDB connected');
  } catch (error) {
    logger.error({ err: error }, 'MongoDB connection failed');
    throw error;
  }
};

module.exports = { connect };

// Quick smoke test: node src/db/connection.js
if (require.main === module) {
  // eslint-disable-next-line global-require
  require('dotenv').config();
  connect()
    .then(() => {
      logger.info('Smoke test passed — disconnecting');
      mongoose.disconnect();
    })
    .catch(() => process.exit(1));
}
