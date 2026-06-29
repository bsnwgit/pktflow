-- pktFlow ClickHouse Schema
-- Run once on fresh ClickHouse install: clickhouse-client < schema.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- Raw flows table  (full resolution, default 90-day TTL)
-- TTL is managed via pktFlow settings; update with ALTER TABLE flows MODIFY TTL
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pktflow.flows (
    -- Time
    timestamp        DateTime64(3)                    COMMENT 'Flow end time (ms precision)',
    -- Sampler
    sampler_ip       IPv4                             COMMENT 'IP of the NetFlow exporter',
    sampler_name     LowCardinality(String)           COMMENT 'Human name from device registry',
    site             LowCardinality(String)           COMMENT 'Site label from device registry',
    -- Layer 3
    src_ip           IPv4,
    dst_ip           IPv4,
    src_port         UInt16,
    dst_port         UInt16,
    protocol         UInt8                            COMMENT 'IP protocol number (6=TCP 17=UDP 1=ICMP)',
    -- Counters
    bytes            UInt64,
    packets          UInt64,
    duration_ms      UInt32                           COMMENT 'Flow duration in milliseconds',
    -- TCP / QoS
    tcp_flags        UInt8,
    tos              UInt8,
    -- Routing
    input_if         UInt32                           COMMENT 'Input interface SNMP index',
    output_if        UInt32                           COMMENT 'Output interface SNMP index',
    next_hop         IPv4,
    src_as           UInt32                           COMMENT 'Source BGP ASN',
    dst_as           UInt32                           COMMENT 'Destination BGP ASN',
    -- Direction (0=ingress 1=egress 2=unknown)
    flow_dir         UInt8                            DEFAULT 2
)
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (sampler_ip, timestamp, src_ip, dst_ip)
TTL toDateTime(timestamp) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;


-- ─────────────────────────────────────────────────────────────────────────────
-- Hourly rollup  (1-year TTL, fed by materialized view)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pktflow.flows_hourly (
    hour             DateTime,
    sampler_ip       IPv4,
    sampler_name     LowCardinality(String),
    site             LowCardinality(String),
    src_ip           IPv4,
    dst_ip           IPv4,
    dst_port         UInt16,
    protocol         UInt8,
    bytes            UInt64,
    packets          UInt64,
    flow_count       UInt64
)
ENGINE = SummingMergeTree((bytes, packets, flow_count))
PARTITION BY toYYYYMM(hour)
ORDER BY (sampler_ip, hour, src_ip, dst_ip, dst_port, protocol)
TTL hour + INTERVAL 365 DAY
SETTINGS index_granularity = 8192;


-- ─────────────────────────────────────────────────────────────────────────────
-- Daily rollup  (no TTL — kept indefinitely for long-term trending)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pktflow.flows_daily (
    day              Date,
    sampler_ip       IPv4,
    sampler_name     LowCardinality(String),
    site             LowCardinality(String),
    bytes            UInt64,
    packets          UInt64,
    flow_count       UInt64,
    unique_src       AggregateFunction(uniq, IPv4),
    unique_dst       AggregateFunction(uniq, IPv4)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (sampler_ip, day)
SETTINGS index_granularity = 8192;


-- ─────────────────────────────────────────────────────────────────────────────
-- Materialized view: flows → flows_hourly
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS pktflow.mv_flows_to_hourly
TO pktflow.flows_hourly
AS
SELECT
    toStartOfHour(timestamp)  AS hour,
    sampler_ip,
    sampler_name,
    site,
    src_ip,
    dst_ip,
    dst_port,
    protocol,
    sum(bytes)                AS bytes,
    sum(packets)              AS packets,
    count()                   AS flow_count
FROM pktflow.flows
GROUP BY hour, sampler_ip, sampler_name, site, src_ip, dst_ip, dst_port, protocol;


-- ─────────────────────────────────────────────────────────────────────────────
-- Materialized view: flows → flows_daily
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS pktflow.mv_flows_to_daily
TO pktflow.flows_daily
AS
SELECT
    toDate(timestamp)         AS day,
    sampler_ip,
    sampler_name,
    site,
    sum(bytes)                AS bytes,
    sum(packets)              AS packets,
    count()                   AS flow_count,
    uniqState(src_ip)         AS unique_src,
    uniqState(dst_ip)         AS unique_dst
FROM pktflow.flows
GROUP BY day, sampler_ip, sampler_name, site;


-- ─────────────────────────────────────────────────────────────────────────────
-- Conversation tracking columns (added non-destructively — old rows default to 0)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE pktflow.flows ADD COLUMN IF NOT EXISTS conversation_id UInt64 DEFAULT 0;
ALTER TABLE pktflow.flows ADD COLUMN IF NOT EXISTS flow_role UInt8 DEFAULT 0;


-- ─────────────────────────────────────────────────────────────────────────────
-- Useful query hints (not executed — for reference)
-- ─────────────────────────────────────────────────────────────────────────────
-- Top talkers for a device, last hour:
--   SELECT src_ip, dst_ip, dst_port, protocol, sum(bytes) AS total_bytes
--   FROM pktflow.flows
--   WHERE sampler_ip = '<ROUTER_IP_2>' AND timestamp >= now() - INTERVAL 1 HOUR
--   GROUP BY src_ip, dst_ip, dst_port, protocol
--   ORDER BY total_bytes DESC LIMIT 50;
--
-- Bytes per minute for a device (time-series):
--   SELECT toStartOfMinute(timestamp) AS minute, sum(bytes) AS bytes
--   FROM pktflow.flows
--   WHERE sampler_ip = '<ROUTER_IP_2>' AND timestamp >= now() - INTERVAL 6 HOUR
--   GROUP BY minute ORDER BY minute;
--
-- Flows/sec right now (last 60 seconds):
--   SELECT count() / 60 AS flows_per_sec
--   FROM pktflow.flows
--   WHERE timestamp >= now() - INTERVAL 60 SECOND;
