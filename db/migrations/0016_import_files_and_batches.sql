-- 0016_import_files_and_batches
-- 阶段 6 工单 01：管理员安全上传原始文件并创建可追溯导入批次。
--
-- 设计要点：
--   - stored_files：一次上传的原始文件事实。storage_key 是服务端生成的不透明键，
--     原名 original_filename 只作元数据展示，绝不参与真实路径构造；真实磁盘路径
--     （含根目录）绝不写入 API 响应。
--   - import_batches：一个导入批次 = 一次上传的元数据事实。状态由服务器权威决定；
--     source_declaration 是管理员对来源的声明（不替代审计）。
--   - 原子性由应用层事务保证：写文件 → 写 stored_files → 写 import_batches → 审计；
--     任一步失败即回滚数据库并删除刚写出的文件，不留下孤儿文件或孤儿记录。
--   - 幂等：同一批次至多对应一个文件；同 batch 重复上传（如客户端重试）由应用层
--     幂等键与部分唯一索引兜底，不产生两份文件。

CREATE TABLE stored_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key text NOT NULL,
  original_filename text NOT NULL,
  declared_mime text NOT NULL,
  sniffed_mime text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256_hex text NOT NULL CHECK (length(sha256_hex) = 64),
  uploaded_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('original_import')),
  status text NOT NULL DEFAULT 'stored'
    CHECK (status IN ('stored', 'pending_cleanup', 'cleaned')),
  format text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stored_files_uploaded_by_idx ON stored_files (uploaded_by);
CREATE INDEX stored_files_created_at_idx ON stored_files (created_at DESC);
CREATE UNIQUE INDEX stored_files_storage_key_unique ON stored_files (storage_key);
CREATE UNIQUE INDEX stored_files_sha256_unique ON stored_files (sha256_hex);

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES stored_files (id) ON DELETE RESTRICT,
  uploaded_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  format text NOT NULL,
  source_declaration text NOT NULL,
  status text NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'validating', 'ready', 'committed', 'failed')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX import_batches_uploaded_by_idx ON import_batches (uploaded_by);
CREATE INDEX import_batches_status_idx ON import_batches (status);
CREATE INDEX import_batches_created_at_idx ON import_batches (created_at DESC);
-- 一个批次文件唯一；重复上传同一批次不得产生两份文件。
CREATE UNIQUE INDEX import_batches_file_id_unique ON import_batches (file_id);
