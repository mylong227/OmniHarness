// 测试夹具：回显收到的 argv（JSON），供外部 CLI worker 端到端判据消费。
process.stdout.write(JSON.stringify(process.argv.slice(2)));
