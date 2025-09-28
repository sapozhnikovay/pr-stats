import { Parser } from '@json2csv/plainjs';
import logger from './logger.js';

export function exportData(data, format) {
  if (format === 'json') {
    logger.info(JSON.stringify(data, null, 2));
  } else if (format === 'csv') {
    const fields = ['url', 'readyDate', 'mergedDate', 'durationHours'];
    const opts = { fields };
    const parser = new Parser();
    const csv = parser.parse(data.pullRequests, opts);
    logger.info(csv);
  } else {
    throw new Error('Unsupported export format. Use "json" or "csv".');
  }
}
