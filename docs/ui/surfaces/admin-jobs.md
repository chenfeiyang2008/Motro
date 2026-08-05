# Admin Job Status

**Responsibility:** diagnose and retry asynchronous content/operations jobs.

**Primary action:** `重试失败任务` on an eligible selected job; running/completed jobs have no primary action.

**Required content:** job type, batch/release link, state, progress, attempts, next retry, sanitized last error, timestamps and request/correlation ID. Filters default to actionable failures.

**Exclude:** raw secrets, unbounded logs in the main table, manual database controls and content editing.
