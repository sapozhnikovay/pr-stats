import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import parseDuration from 'parse-duration';
import logger from './logger.js';

const MyOctokit = Octokit.plugin(throttling);
const octokit = new MyOctokit({
  throttle: {
    onRateLimit: (retryAfter, options) => {
      logger.debug(`Request quota exhausted for request ${options.method} ${options.url}`);
      logger.debug(`Retrying after ${retryAfter} seconds`);
      return true;
    },
    onSecondaryRateLimit: (retryAfter, options) => {
      logger.debug(`Secondary request quota exhausted for request ${options.method} ${options.url}`);
      logger.debug(`Retrying after ${retryAfter} seconds`);
      return true;
    },
  },
  log: {
    warn: () => {},
    error: () => {},
    info: () => {},
    debug: () => {},
  },
});

/**
 * Get the authenticated user's login name.
 */
export async function getAuthenticatedUser(token) {
  const { data } = await octokit.users.getAuthenticated({
    auth: token,
    headers: {
      Authorization: `token ${token}`,
    },
  });
  return data.login;
}

/**
 * Parse a period string like "2d", "1w", "3mo", or "1y" and return the Date
 * corresponding to now minus that duration.
 */
export function parsePeriod(periodStr) {
  const durationMs = parseDuration(periodStr);
  if (!durationMs) {
    throw new Error('Invalid period format. Use e.g. "2d", "1w", "3mo", or "1y".');
  }
  return new Date(Date.now() - durationMs);
}

/**
 * Parse a date string in the format YYYY-MM-DD and return a Date object.
 */
export function parseDate(dateStr) {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date format: ${dateStr}. Use YYYY-MM-DD.`);
  }
  return date;
}

/**
 * Split a date range into chunks to avoid GitHub's 1000 result limit.
 * Returns an array of { start, end } date objects.
 */
export function createTimeChunks(since, until, maxResults = 1000) {
  const chunks = [];
  const totalDays = Math.ceil((until - since) / (1000 * 60 * 60 * 24));

  // Determine chunk size based on total time range
  let chunkSizeDays;
  if (totalDays <= 7) {
    // For ranges up to a week, chunk by hours
    chunkSizeDays = 1 / 24; // 1 hour
  } else if (totalDays <= 30) {
    // For ranges up to a month, chunk by days
    chunkSizeDays = 1;
  } else if (totalDays <= 60) {
    // For ranges up to 2 months, chunk by weeks
    chunkSizeDays = 7;
  } else {
    // For anything longer than 3 months, chunk by 2 months
    chunkSizeDays = 60; // 2 months
  }

  let currentStart = new Date(since);
  const chunkSizeMs = chunkSizeDays * 24 * 60 * 60 * 1000;

  while (currentStart < until) {
    const currentEnd = new Date(Math.min(currentStart.getTime() + chunkSizeMs, until.getTime()));
    chunks.push({
      start: new Date(currentStart),
      end: new Date(currentEnd),
    });
    currentStart = new Date(currentEnd.getTime() + 1); // Add 1ms to avoid overlap
  }

  return chunks;
}

/**
 * Validate that the given username is searchable via the :author filter.
 * It runs a dummy search query and checks for a 422 error containing the expected message.
 */
async function validateQueryableAuthor(username) {
  try {
    const query = `type:pr author:${username}`;
    // Attempt a dummy search query with just one result per page.
    await octokit.request('GET /search/issues', {
      q: query,
      per_page: 1,
      advanced_search: true,
    });
    // If no error is thrown, the user is searchable.
    return true;
  } catch (error) {
    // Octokit throws an error with status 422 for unsearchable users.
    if (error.status === 422 && error.message.includes('The listed users cannot be searched')) {
      logger.debug(`User "${username}" is not searchable. Need to filter PRs by author manually.`);
      return false;
    }
    // For any other error, rethrow or handle accordingly.
    throw new Error(`Error checking queryability of user "${username}": ${error.message}`);
  }
}

/**
 * Fetch pull requests for a single time chunk.
 */
async function fetchPullRequestsForChunk(usernames, org, repo, since, until, token, allPublic) {
  const sinceStr = since.toISOString().split('T')[0];
  const untilStr = until ? until.toISOString().split('T')[0] : '';
  let query = `type:pr is:merged merged:>=${sinceStr}`;
  if (untilStr) {
    query = `type:pr is:merged merged:${sinceStr}..${untilStr}`;
  }

  // Add organization/repo filter
  if (repo) {
    if (repo.includes('/')) {
      query += ` repo:${repo}`;
    } else {
      query += ` repo:${org}/${repo}`;
    }
  } else {
    query += ` org:${org}`;
  }

  // Use :author filter only if all usernames are public
  if (allPublic.every((isPublic) => isPublic)) {
    const userQueries = usernames.map((username) => `author:${username}`).join(' OR ');
    // Add parentheses only if there are multiple users
    if (usernames.length > 1) {
      query += ` (${userQueries})`;
    } else {
      query += ` ${userQueries}`;
    }
  }

  logger.debug(`Chunk query: ${query}`);
  logger.debug(`Chunk date range: ${sinceStr} to ${untilStr}`);

  const prs = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    logger.debug(`Fetching page ${page} for chunk ${sinceStr} to ${untilStr}`);

    const { data } = await octokit.request('GET /search/issues', {
      q: query,
      per_page: perPage,
      advanced_search: true,
      page,
      headers: {
        Authorization: `token ${token}`,
      },
    });

    logger.debug(
      `Page ${page} returned ${data.items ? data.items.length : 0} items (total: ${data.total_count || 'unknown'})`
    );

    if (!data.items || data.items.length === 0) break;
    prs.push(...data.items);
    if (data.items.length < perPage) break;
    page++;
  }

  logger.debug(`Chunk ${sinceStr} to ${untilStr} completed with ${prs.length} total PRs`);
  return prs;
}

/**
 * Check if chunking is needed by getting the total count from GitHub's search API.
 */
async function checkIfChunkingNeeded(usernames, org, repo, since, until, token, allPublic) {
  const sinceStr = since.toISOString().split('T')[0];
  const untilStr = until ? until.toISOString().split('T')[0] : '';
  let query = `type:pr is:merged merged:>=${sinceStr}`;
  if (untilStr) {
    query = `type:pr is:merged merged:${sinceStr}..${untilStr}`;
  }

  // Add organization/repo filter
  if (repo) {
    if (repo.includes('/')) {
      query += ` repo:${repo}`;
    } else {
      query += ` repo:${org}/${repo}`;
    }
  } else {
    query += ` org:${org}`;
  }

  // Use :author filter only if all usernames are public
  if (allPublic.every((isPublic) => isPublic)) {
    const userQueries = usernames.map((username) => `author:${username}`).join(' OR ');
    // Add parentheses only if there are multiple users
    if (usernames.length > 1) {
      query += ` (${userQueries})`;
    } else {
      query += ` ${userQueries}`;
    }
  }

  // Make a minimal request to get the total count
  logger.debug(`Checking total count with query: ${query}`);
  const { data } = await octokit.request('GET /search/issues', {
    q: query,
    per_page: 1,
    advanced_search: true,
    headers: {
      Authorization: `token ${token}`,
    },
  });

  logger.debug(`Total count: ${data.total_count}`);
  return data.total_count > 1000;
}

/**
 * Use GitHub's search API to get pull requests authored by the specified users
 * in the given organization (and repository, if provided) that were merged
 * since the given date. Automatically chunks large date ranges to avoid the 1000 result limit.
 */
export async function fetchPullRequests(usernames, org, repo, since, until, token) {
  const allPublic = await Promise.all(usernames.map(validateQueryableAuthor));

  // Check if chunking is needed based on total count
  const needsChunking = await checkIfChunkingNeeded(usernames, org, repo, since, until, token, allPublic);

  if (needsChunking) {
    logger.debug(`Total results exceed 1000, splitting into time chunks...`);

    // Create time chunks and fetch each one
    const chunks = createTimeChunks(since, until);
    logger.debug(`Splitting into ${chunks.length} time chunks`);

    const allPrs = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      logger.debug(
        `=== Starting chunk ${i + 1}/${chunks.length}: ${chunk.start.toISOString().split('T')[0]} to ${
          chunk.end.toISOString().split('T')[0]
        } ===`
      );

      try {
        const chunkPrs = await fetchPullRequestsForChunk(
          usernames,
          org,
          repo,
          chunk.start,
          chunk.end,
          token,
          allPublic
        );
        allPrs.push(...chunkPrs);
        logger.debug(`Chunk ${i + 1} completed successfully with ${chunkPrs.length} PRs`);
      } catch (chunkError) {
        logger.debug(`Error fetching chunk ${i + 1}: ${chunkError.message}`);
        logger.debug(
          `Chunk details: ${chunk.start.toISOString().split('T')[0]} to ${chunk.end.toISOString().split('T')[0]}`
        );
        // Continue with other chunks
      }

      // Add a longer delay to avoid rate limiting
      if (i < chunks.length - 1) {
        logger.debug(`Waiting 2 seconds before next chunk to avoid rate limiting...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    // If not all usernames are public, filter PRs by author manually
    if (!allPublic.every((isPublic) => isPublic)) {
      return allPrs.filter((pr) => usernames.map((u) => u.toLowerCase()).includes(pr.user.login.toLowerCase()));
    }

    return allPrs;
  } else {
    // No chunking needed, fetch all results normally
    const prs = await fetchPullRequestsForChunk(usernames, org, repo, since, until, token, allPublic);

    // If not all usernames are public, filter PRs by author manually
    if (!allPublic.every((isPublic) => isPublic)) {
      return prs.filter((pr) => usernames.map((u) => u.toLowerCase()).includes(pr.user.login.toLowerCase()));
    }

    return prs;
  }
}

/**
 * For a given pull request, fetch its timeline events (which include events
 * like "ready_for_review"). We need the first time the PR became "ready."
 *
 * Note: GitHub's timeline API is currently in preview, so we must include the
 * special Accept header.
 */
export async function fetchReadyTime(owner, repo, prNumber, fallbackCreatedAt, token) {
  const { data: events } = await octokit.issues.listEventsForTimeline({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
    headers: {
      accept: 'application/vnd.github.mockingbird-preview+json',
      Authorization: `token ${token}`,
    },
  });

  const readyEvent = events.find((e) => e.event === 'ready_for_review');
  if (readyEvent) {
    return new Date(readyEvent.created_at);
  }
  return new Date(fallbackCreatedAt);
}

/**
 * Load the list of pull requests.
 */
export async function loadPullRequests(users, org, repo, sinceDate, untilDate, token, logProgress) {
  if (logProgress) {
    if (repo) {
      logger.debug(
        `Fetching PR stats for users ${users.join(', ')} in repo ${repo.includes('/') ? repo : `${org}/${repo}`}...`
      );
    } else {
      logger.debug(`Fetching PR stats for users ${users.join(', ')} in organization ${org}...`);
    }
  }

  const prItems = await fetchPullRequests(users, org, repo, sinceDate, untilDate, token);
  if (logProgress) {
    logger.debug(`Found ${prItems.length} pull request(s).`);
  }

  return prItems;
}

/**
 * Calculate the average duration of pull requests.
 */
export async function calculateAverageDuration(prItems, token, logProgress) {
  let totalDurationHours = 0;
  let count = 0;

  const prDataList = [];

  for (const prItem of prItems) {
    const prUrl = prItem.pull_request.url;
    const { data: prData } = await octokit.request(`GET ${prUrl}`, {
      headers: {
        Authorization: `token ${token}`,
        'User-Agent': 'PR-Stats-App',
      },
    });

    if (!prData.merged_at) continue;
    const mergeTime = new Date(prData.merged_at);

    const ownerName = prData.base.repo.owner.login;
    const repoName = prData.base.repo.name;
    const prNumber = prData.number;
    const createdAt = prData.created_at;

    const readyTime = await fetchReadyTime(ownerName, repoName, prNumber, createdAt, token);

    const durationMs = mergeTime - readyTime;
    const durationHours = durationMs / (1000 * 60 * 60);

    prDataList.push({
      url: prUrl,
      readyDate: readyTime.toISOString(),
      mergedDate: mergeTime.toISOString(),
      durationHours: durationHours.toFixed(2),
    });

    if (logProgress) {
      logger.debug(
        `PR #${prNumber} (${ownerName}/${repoName}): Ready at ${readyTime.toISOString()}, Merged at ${mergeTime.toISOString()} → Duration: ${durationHours.toFixed(
          2
        )} hours`
      );
    }

    totalDurationHours += durationHours;
    count++;
  }

  return { totalDurationHours, count, prDataList };
}
