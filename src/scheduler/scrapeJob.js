'use strict';

// Standalone scheduler — run this as a separate process from the API server.
// Usage: node src/scheduler/scrapeJob.js
//
// Scrapes each region sequentially every 6 hours.
// If one region fails, the error is logged and the job continues with the next.

require('dotenv').config();
const https = require('https');
const cron = require('node-cron');
const { run } = require('../scrapper/jdSportsScraper');
const logger = require('../config/logger');

// Ping the revalidate endpoint after every scrape run so the frontend picks up fresh data.
// Uses Node's built-in http — no extra dependency needed.
const pingRevalidate = () => {
  const options = {
    hostname: 'kickmap.sijar.tech',
    path: '/api/revalidate',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.REVALIDATE_TOKEN}`,
    },
  };

  const req = https.request(options, (res) => {
    logger.info({ status: res.statusCode }, 'revalidate ping sent');
  });

  req.on('error', (err) => {
    // Non-fatal — scrape already succeeded, just log the miss
    logger.warn({ err }, 'revalidate ping failed');
  });

  req.end();
};

const REGIONS = ['MY', 'ID', 'SG'];
const CRON_SCHEDULE = '0 */6 * * *';

/**
 * Run all regions sequentially.
 * A single region failure does not abort the remaining regions.
 *
 * Uses reduce to chain promises in order without for..of or await-in-loop.
 */
const runAll = async () => {
  logger.info({ regions: REGIONS }, 'scheduled scrape job started');

  // eslint-disable-next-line no-restricted-syntax, no-await-in-loop
  await REGIONS.reduce(async (prev, region) => {
    await prev;
    try {
      await run(region);
    } catch (err) {
      // Log and continue — stale data for one region is better than skipping all
      logger.error({ err, region }, 'region scrape failed, continuing to next');
    }
  }, Promise.resolve());

  logger.info('scheduled scrape job finished');
  pingRevalidate();
};

const startScheduler = () => {
  logger.info({ schedule: CRON_SCHEDULE }, 'scheduler registered');

  cron.schedule(CRON_SCHEDULE, () => {
    runAll().catch((err) => {
      logger.error({ err }, 'unexpected error in runAll');
    });
  });
};

startScheduler();
