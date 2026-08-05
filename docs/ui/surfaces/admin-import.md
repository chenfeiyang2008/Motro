# Admin Import

**Responsibility:** turn one source file into a validated import batch.

**Primary action:** advances by stage: `上传文件` → `开始校验` → `提交有效行`; only one is strong at a time.

**Required content:** file/source declaration, format or worksheet selection, column mapping, validation summary, row-level errors, duplicate decisions, downloadable error report and immutable batch status. Preserve the uploaded file and mapping after recoverable errors.

**Exclude:** inline course composition, AI approval, automatic publishing and unrelated previous-job analytics.
