ATTACH TABLE _ UUID 'a1c52fdd-ecd7-4427-bb03-6eecc50a7c85'
(
    `operation_id` String,
    `machine_id` String,
    `production_order_id` String,
    `scheduled_start` DateTime,
    `scheduled_end` DateTime,
    `actual_start` Nullable(DateTime),
    `actual_end` Nullable(DateTime),
    `good_units` UInt32,
    `total_units` UInt32,
    `scrap_units` UInt32,
    `setup_time_min` Float32,
    `processing_time_min` Float32,
    `downtime_min` Float32,
    `event_date` Date DEFAULT toDate(scheduled_start)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (machine_id, scheduled_start)
SETTINGS index_granularity = 8192
