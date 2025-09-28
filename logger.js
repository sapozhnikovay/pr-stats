const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

let currentLevel = LEVELS.info;

function shouldLog(level) {
  return level >= currentLevel && currentLevel !== LEVELS.silent;
}

const logger = {
  setLevel(level) {
    const normalized = String(level || '').toLowerCase();
    if (LEVELS.hasOwnProperty(normalized)) {
      currentLevel = LEVELS[normalized];
    }
  },
  debug(message) {
    if (shouldLog(LEVELS.debug)) {
      // Using console.debug may be hidden in some environments; console.log is fine
      console.log(message);
    }
  },
  info(message) {
    if (shouldLog(LEVELS.info)) {
      console.log(message);
    }
  },
  warn(message) {
    if (shouldLog(LEVELS.warn)) {
      console.warn(message);
    }
  },
  error(message) {
    if (shouldLog(LEVELS.error)) {
      console.error(message);
    }
  },
};

export default logger;
