const core = require("@actions/core");
const github = require("@actions/github");
const lfs_core = require("lightning-flow-scanner-core");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const CONFIG_PATHS = [
  ".flow-scanner.yaml",
  ".flow-scanner.yml",
  ".flow-scanner.json",
  "config/.flow-scanner.yaml",
  "config/.flow-scanner.yml",
  ".flow-scanner"
];

const SEVERITY_LEVELS = ["note", "warning", "error"];

async function loadConfig() {
  for (const configPath of CONFIG_PATHS) {
    if (fs.existsSync(configPath)) {
      core.info(`Found config file: ${configPath}`);
      try {
        const raw = fs.readFileSync(configPath, "utf8");
        const ext = path.extname(configPath).toLowerCase();
        if (ext === ".yaml" || ext === ".yml" || configPath === ".flow-scanner") {
          return yaml.load(raw);
        } else if (ext === ".json") {
          return JSON.parse(raw);
        }
      } catch (err) {
        core.warning(`Failed to parse config file ${configPath}: ${err.message}`);
      }
    }
  }
  core.info("No config file found. Using default scanner behavior.");
  return {};
}

function getSeverityThreshold(config) {
  // First check workflow input
  const thresholdInput = core.getInput("severityThreshold");
  if (SEVERITY_LEVELS.includes(thresholdInput)) {
    core.info(`Using severity threshold from workflow input: ${thresholdInput}`);
    return thresholdInput;
  }

  // Else check config file
  if (config?.severityThreshold && SEVERITY_LEVELS.includes(config.severityThreshold)) {
    core.info(`Using severity threshold from config file: ${config.severityThreshold}`);
    return config.severityThreshold;
  }

  // Fallback
  core.info("Using default severity threshold: warning");
  return "warning";
}

function meetsThreshold(severity, threshold) {
  const sevIndex = SEVERITY_LEVELS.indexOf(severity);
  const thIndex = SEVERITY_LEVELS.indexOf(threshold);
  return sevIndex >= thIndex;
}

async function run() {
  const GITHUB_TOKEN = core.getInput("GITHUB_TOKEN");
  const octokit = github.getOctokit(GITHUB_TOKEN);
  const { context } = github;
  const repo = context.repo;

  try {
    let files = [];
    let head_sha;

    // Resolve commit SHA
    if (context.eventName === "pull_request") {
      head_sha = context.payload.pull_request.head.sha;
    } else {
      const { data: defaultBranch } = await octokit.rest.repos.getBranch({
        owner: repo.owner,
        repo: repo.repo,
        branch: "master"
      });
      head_sha = defaultBranch.commit.sha;
    }

    // Collect flow files
    if (context.eventName === "pull_request") {
      const pull_number = context.payload.pull_request.number;
      const { data: prFiles } = await octokit.rest.pulls.listFiles({
        owner: repo.owner,
        repo: repo.repo,
        pull_number
      });
      files = prFiles
        .map(file => file.filename)
        .filter(file => file.endsWith("flow-meta.xml") || file.endsWith("flow"));
    } else {
      const { data: latestCommit } = await octokit.rest.repos.listCommits({
        owner: repo.owner,
        repo: repo.repo,
        per_page: 1
      });
      const latestCommitSha = latestCommit[0].sha;

      const { data: tree } = await octokit.rest.git.getTree({
        owner: repo.owner,
        repo: repo.repo,
        tree_sha: latestCommitSha,
        recursive: true
      });

      files = tree.tree
        .filter(
          item =>
            item.type === "blob" &&
            (item.path.endsWith("flow-meta.xml") || item.path.endsWith("flow"))
        )
        .map(item => item.path);
    }

    // Load scanner config
    const config = await loadConfig();
    const severityThreshold = getSeverityThreshold(config);

    // Parse flows
    let pFlows = [];
    for (const file of files) {
      pFlows.push(...(await lfs_core.parse([file])));
    }

    if (pFlows.length > 0) {
      console.log("Scanning " + pFlows.length + " Flows...");
      let scanResults = [];
      for (let flow of pFlows) {
        // Pass IRulesConfig into scanner
        const res = lfs_core.scan([flow], config);
        scanResults.push(...res);
      }

      if (scanResults) {
        const tableRows = [];
        const thresholdViolations = [];

        for (let scanResult of scanResults) {
          if (scanResult.ruleResults.length > 0) {
            for (let ruleResult of scanResult.ruleResults) {
              if (ruleResult.occurs) {
                let details = ruleResult.details;
                if (Array.isArray(details) && details.length > 0) {
                  for (let detail of details) {
                    const severity =
                      config.rules?.[ruleResult.ruleName]?.severity ||
                      ruleResult.severity ||
                      "warning"; 
                    const row = {
                      flow: scanResult.flow.name,
                      violation: detail.name || "",
                      rule: ruleResult.ruleName,
                      type: detail.type || "",
                      severity
                    };
                    tableRows.push(row);

                    if (meetsThreshold(severity, severityThreshold)) {
                      thresholdViolations.push(row);
                    }
                  }
                }
              }
            }
          }
        }

        core.setOutput("scanResults", tableRows);
        if (tableRows.length > 0) {
          console.table(tableRows, ["flow", "violation", "type", "rule", "severity"]);
        }

        if (thresholdViolations.length > 0) {
          core.setFailed(
            `${thresholdViolations.length} violations at severity >= ${severityThreshold} in ${pFlows.length} Flows.`
          );
        } else {
          core.info(
            `0 violations at severity >= ${severityThreshold} in ${pFlows.length} Flows.`
          );
        }
      }
    } else {
      core.info(`No Flows identified within the repository..`);
    }
  } catch (e) {
    console.error(e);
    core.setFailed(e.message);
  }
}

run();
