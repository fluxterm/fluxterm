use std::hint::black_box;

use criterion::{Criterion, Throughput, criterion_group, criterion_main};
use rdp_core::benchmark_support::{
    build_rgba_frame_batch_message, build_rgba_frame_message, copy_rgba_rect,
    create_test_rgba_surface,
};

type BenchRect = (u32, u32, u32, u32);

const SURFACE_WIDTH: u32 = 1366;
const SURFACE_HEIGHT: u32 = 768;

fn rect_bytes((_, _, width, height): BenchRect) -> u64 {
    u64::from(width) * u64::from(height) * 4
}

fn rects_bytes(rects: &[BenchRect]) -> u64 {
    rects.iter().copied().map(rect_bytes).sum()
}

fn drag_stripe_rects() -> Vec<BenchRect> {
    (0..12)
        .map(|index| {
            let y = 80 + index * 44;
            (72, y, 1220, 10)
        })
        .collect()
}

fn fragmented_browser_rects() -> Vec<BenchRect> {
    let mut rects = Vec::with_capacity(48);
    for row in 0..8 {
        let y = 60 + row * 72;
        rects.push((72, y, 880, 12));
        rects.push((72, y + 18, 24, 42));
        rects.push((928, y + 18, 260, 42));
        rects.push((160 + row * 11, y + 28, 520, 18));
        rects.push((760, y + 28, 340, 18));
        rects.push((1120, y + 18, 80, 42));
    }
    rects
}

fn bench_copy_rect(c: &mut Criterion) {
    let surface = create_test_rgba_surface(SURFACE_WIDTH, SURFACE_HEIGHT);
    let cases = [
        ("small_320x180", (120, 96, 320, 180)),
        ("half_683x384", (220, 180, 683, 384)),
        ("full_1366x768", (0, 0, SURFACE_WIDTH, SURFACE_HEIGHT)),
    ];

    let mut group = c.benchmark_group("rdp_frame_copy_rect");
    for (name, rect) in cases {
        let mut dest = vec![0; rect_bytes(rect) as usize];
        group.throughput(Throughput::Bytes(rect_bytes(rect)));
        group.bench_function(name, |b| {
            b.iter(|| {
                copy_rgba_rect(
                    black_box(&surface),
                    black_box(SURFACE_WIDTH),
                    black_box(rect),
                    black_box(&mut dest),
                )
            })
        });
    }
    group.finish();
}

fn bench_single_message(c: &mut Criterion) {
    let surface = create_test_rgba_surface(SURFACE_WIDTH, SURFACE_HEIGHT);
    let cases = [
        ("small_320x180", (120, 96, 320, 180)),
        ("half_683x384", (220, 180, 683, 384)),
        ("full_1366x768", (0, 0, SURFACE_WIDTH, SURFACE_HEIGHT)),
    ];

    let mut group = c.benchmark_group("rdp_frame_single_message");
    for (name, rect) in cases {
        group.throughput(Throughput::Bytes(rect_bytes(rect)));
        group.bench_function(name, |b| {
            b.iter(|| {
                build_rgba_frame_message(
                    black_box(&surface),
                    black_box(SURFACE_WIDTH),
                    black_box(SURFACE_HEIGHT),
                    black_box(rect),
                )
            })
        });
    }
    group.finish();
}

fn bench_batch_message(c: &mut Criterion) {
    let surface = create_test_rgba_surface(SURFACE_WIDTH, SURFACE_HEIGHT);
    let stripe_rects = drag_stripe_rects();
    let fragmented_rects = fragmented_browser_rects();

    let mut group = c.benchmark_group("rdp_frame_batch_message");
    group.throughput(Throughput::Bytes(rects_bytes(&stripe_rects)));
    group.bench_function("drag_stripes_12", |b| {
        b.iter(|| {
            build_rgba_frame_batch_message(
                black_box(&surface),
                black_box(SURFACE_WIDTH),
                black_box(SURFACE_HEIGHT),
                black_box(&stripe_rects),
            )
        })
    });

    group.throughput(Throughput::Bytes(rects_bytes(&fragmented_rects)));
    group.bench_function("fragmented_browser_48", |b| {
        b.iter(|| {
            build_rgba_frame_batch_message(
                black_box(&surface),
                black_box(SURFACE_WIDTH),
                black_box(SURFACE_HEIGHT),
                black_box(&fragmented_rects),
            )
        })
    });
    group.finish();
}

criterion_group!(
    benches,
    bench_copy_rect,
    bench_single_message,
    bench_batch_message
);
criterion_main!(benches);
