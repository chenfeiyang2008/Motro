-- 0011_fsrs_scheduler_parameters
-- 学习卡调度状态补全：参数版本列 + 学习步骤计数列。
-- 与调度器算法版本明确区分、独立可追溯。
--
-- 背景：0010 的 learning_cards.scheduler_version 只区分算法（'fsrs-v6'），
-- 无法在同一算法下追踪参数集合（权重、保留率、最大间隔、模糊/短时开关、学习步骤）。
-- 阶段 5 工单 02 引入确定性 FSRS v6 适配器，调度完全由「卡状态 + 服务器时间 + 参数版本 + 四级评分」
-- 决定；需要持久化本次调度所用的参数版本，以便日后参数变更时对既有卡做可追溯重放。
--
-- 同时补上 learning_steps 列：ts-fsrs 用「已完成的学习/再学习步骤数」决定下一步，
-- 只存 state 三态（new/learning/review）会丢失步骤进度，导致回放失真（见 02 适配器说明）。
-- 既有行均为 new 卡（未调度），两步都回填安全默认：learning_steps=0。
--
-- 本迁移只新增列并回填固定默认值：
--   - 已有卡（'learning_card' 既有行）的调度发生在该参数版本被采用之前，回填为
--     'fsrs-v6/default'——一个明确的无参数版本占位，不与调度产生的版本混同。
--   - 之后由 02 适配器写入调度结果时，该列保存实际使用的 fsrsParameterVersion()。
-- 不修改既有 migration 0010（保持已应用文件哈希稳定）。

ALTER TABLE learning_cards
  ADD COLUMN scheduler_parameters_version text NOT NULL DEFAULT 'fsrs-v6/default',
  ADD COLUMN learning_steps integer NOT NULL DEFAULT 0;

-- 列存在性测试在集成测试中覆盖：学习卡行默认得到新列且非空。
