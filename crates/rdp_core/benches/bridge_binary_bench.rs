use std::hint::black_box;

use axum::extract::ws::Message;
use criterion::{BatchSize, Criterion, Throughput, criterion_group, criterion_main};
use tokio::sync::broadcast;

fn make_payload(bytes: usize) -> Vec<u8> {
    (0..bytes).map(|index| (index & 0xff) as u8).collect()
}

fn bench_broadcast_binary(c: &mut Criterion) {
    let cases = [
        ("small_320x180_rgba", 320 * 180 * 4),
        ("half_683x384_rgba", 683 * 384 * 4),
        ("full_1366x768_rgba", 1366 * 768 * 4),
    ];

    let mut group = c.benchmark_group("rdp_bridge_binary_broadcast");
    for (name, bytes) in cases {
        let payload = make_payload(bytes);
        group.throughput(Throughput::Bytes(bytes as u64));
        group.bench_function(format!("{name}_one_subscriber"), |b| {
            b.iter_batched(
                || {
                    let (sender, receiver) = broadcast::channel::<Message>(8);
                    let message = Message::Binary(black_box(payload.clone()).into());
                    (sender, receiver, message)
                },
                |(sender, mut receiver, message)| {
                    let _ = sender.send(message);
                    let _ = receiver.try_recv();
                },
                BatchSize::SmallInput,
            )
        });
    }
    group.finish();
}

criterion_group!(benches, bench_broadcast_binary);
criterion_main!(benches);
