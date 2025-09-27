import { Octokit } from '@octokit/rest';
import parseDuration from 'parse-duration';
import logger from './logger.js';

const octokit = new Octokit();

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
 * Validate that the given username is searchable via the :author filter.
 * It runs a dummy search query and checks for a 422 error containing the expected message.
 */
async function validateQueryableAuthor(username) {
  try {
    const query = `type:pr author:${username}`;
    // Attempt a dummy search query with just one result per page.
    await octokit.search.issuesAndPullRequests({
      q: query,
      per_page: 1,
      advanced_search: true,
    });
    // If no error is thrown, the user is searchable.
    return true;
  } catch (error) {
    // Octokit throws an error with status 422 for unsearchable users.
    if (error.status === 422 && error.message.includes('The listed users cannot be searched')) {
      return false;
    }
    // For any other error, rethrow or handle accordingly.
    throw new Error(`Error checking queryability of user "${username}": ${error.message}`);
  }
}

/**
 * Use GitHub's search API to get pull requests authored by the specified users
 * in the given organization (and repository, if provided) that were merged
 * since the given date.
 */
export async function fetchPullRequests(usernames, org, repo, since, until, token) {
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

  const allPublic = await Promise.all(usernames.map(validateQueryableAuthor));

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

  const prs = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data } = await octokit.search.issuesAndPullRequests({
      q: query,
      per_page: perPage,
      advanced_search: true,
      page,
      headers: {
        Authorization: `token ${token}`,
      },
    });

    if (!data.items || data.items.length === 0) break;
    prs.push(...data.items);
    if (data.items.length < perPage) break;
    page++;
  }

  // If not all usernames are public, filter PRs by author manually
  if (!allPublic.every((isPublic) => isPublic)) {
    return prs.filter((pr) => usernames.map((u) => u.toLowerCase()).includes(pr.user.login.toLowerCase()));
  }

  return prs;
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
      logger.info(
        `Fetching PR stats for users ${users.join(', ')} in repo ${repo.includes('/') ? repo : `${org}/${repo}`}...`
      );
    } else {
      logger.info(`Fetching PR stats for users ${users.join(', ')} in organization ${org}...`);
    }
  }

  const prItems = await fetchPullRequests(users, org, repo, sinceDate, untilDate, token);
  if (logProgress) {
    logger.info(`Found ${prItems.length} pull request(s).`);
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
      logger.info(
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
