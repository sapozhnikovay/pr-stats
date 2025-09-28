#!/usr/bin/env node
/**
 * PR Stats Console App
 *
 * This script calculates the average duration (in hours) between the time
 * a pull request becomes "ready for review" and the time it is merged.
 * It uses GitHub's API to fetch pull requests, filtered by organization,
 * optional repository, a specified time period, and optionally by a specific GitHub username.
 *
 * By default, if no user is specified, it shows stats for the authenticated user's PRs.
 *
 * Usage:
 *   node index.js --org my-org --period 1w --token YOUR_GITHUB_TOKEN
 *   node index.js --org my-org --repo my-repo --period 3mo --user otherUser --token YOUR_GITHUB_TOKEN
 *   node index.js --org my-org --start 2022-01-01 --end 2022-01-31 --token YOUR_GITHUB_TOKEN
 */

import { program } from 'commander';
import logger from './logger.js';
import { exportData } from './exporter.js';
import {
  getAuthenticatedUser,
  parsePeriod,
  parseDate,
  loadPullRequests,
  calculateAverageDuration,
} from './businessLogic.js';

// Define command-line options
program
  .requiredOption('-o, --org <org>', 'GitHub organization name')
  .option('-r, --repo <repo>', 'Filter by specific repository (optional)')
  .option('-p, --period <period>', "Time period (e.g., '2d', '1w', '3mo', '1y')")
  .option('--start <date>', 'Start date (YYYY-MM-DD)')
  .option('--end <date>', 'End date (YYYY-MM-DD)')
  .option('-u, --user <usernames>', 'Filter PRs by GitHub usernames (comma-separated list)')
  .option('-t, --token <token>', 'GitHub personal access token (can also be set via GITHUB_TOKEN env variable)')
  .option('--export <format>', 'Export data in the specified format (json or csv)')
  .option('--log-level <level>', 'Log level: debug | info | warn | error | silent', 'info')
  .parse(process.argv);

const options = program.opts();
logger.setLevel(options.logLevel);
const org = options.org;
const repo = options.repo;
const periodStr = options.period;
const startDateStr = options.start;
const endDateStr = options.end;

// Get token from command line or environment variable
const token = options.token || process.env.GITHUB_TOKEN;

if (!token) {
  logger.error('GitHub token is required. Provide it via --token option or GITHUB_TOKEN environment variable');
  process.exit(1);
}

if (!periodStr && !startDateStr && !endDateStr) {
  logger.error('Either --period or --start option or --start and --end options are required.');
  process.exit(1);
}

if (periodStr && (startDateStr || endDateStr)) {
  logger.error('The --period option cannot be used with --start or --end options.');
  process.exit(1);
}

if (endDateStr && !startDateStr) {
  logger.error('The --end option cannot be used without the --start option.');
  process.exit(1);
}

if (options.export && !['json', 'csv'].includes(options.export)) {
  logger.error('Unsupported export format. Use "json" or "csv".');
  process.exit(1);
}

/**
 * Main function: Get the specified users' PRs, compute each duration
 * (in hours) from "ready" until merged, and output the average duration.
 */
async function main() {
  try {
    const searchUsers = options.user ? options.user.split(',').map((u) => u.trim()) : [];

    const sinceDate = startDateStr ? parseDate(startDateStr) : parsePeriod(periodStr);
    const untilDate = endDateStr ? parseDate(endDateStr) : new Date();

    const logProgress = !options.export;

    if (logProgress) {
      if (searchUsers.length > 0) {
        logger.info(
          `Analyzing PRs by users: ${searchUsers.join(
            ', '
          )} from ${sinceDate.toISOString()} to ${untilDate.toISOString()}`
        );
      } else {
        logger.info(`Analyzing all PRs from ${sinceDate.toISOString()} to ${untilDate.toISOString()}`);
      }
    }

    const prItems = await loadPullRequests(searchUsers, org, repo, sinceDate, untilDate, token, logProgress);
    const { totalDurationHours, count, prDataList } = await calculateAverageDuration(prItems, token, logProgress);

    if (count > 0) {
      const avgDuration = totalDurationHours / count;

      if (options.export) {
        exportData(
          {
            averageDurationHours: avgDuration.toFixed(2),
            pullRequests: prDataList,
          },
          options.export
        );
      } else {
        logger.info(`\nAverage merge duration: ${avgDuration.toFixed(2)} hours over ${count} pull request(s).`);
      }
    } else {
      if (logProgress) {
        logger.info('No pull requests found in the specified period.');
      }
    }
  } catch (error) {
    logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
