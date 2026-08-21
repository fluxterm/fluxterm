use std::hint::black_box;

use criterion::{Criterion, criterion_group, criterion_main};
use fluxterm_rdp_core::benchmark_support::evaluate_overdraw_policy;

type BenchRect = (u16, u16, u16, u16);

fn dense_tile_rects() -> Vec<BenchRect> {
    let mut rects = Vec::with_capacity(64);
    for row in 0..8_u16 {
        for col in 0..8_u16 {
            let left = 80 + col * 34;
            let top = 80 + row * 26;
            rects.push((left, top, left + 24, top + 18));
        }
    }
    rects
}

fn sparse_widget_rects() -> Vec<BenchRect> {
    vec![
        (40, 40, 180, 110),
        (1120, 52, 1290, 140),
        (64, 560, 220, 710),
        (980, 520, 1320, 740),
        (520, 280, 720, 380),
        (760, 180, 900, 260),
    ]
}

fn drag_browser_rects() -> Vec<BenchRect> {
    let mut rects = Vec::with_capacity(48);
    for row in 0..12_u16 {
        let y = 64 + row * 44;
        rects.push((56, y, 1300, y + 8));
        rects.push((56, y + 14, 82, y + 38));
        rects.push((1274, y + 14, 1300, y + 38));
        rects.push((160 + row * 7, y + 18, 460 + row * 7, y + 30));
    }
    rects
}

fn checkerboard_rects() -> Vec<BenchRect> {
    let mut rects = Vec::with_capacity(80);
    for row in 0..10_u16 {
        for col in 0..8_u16 {
            let left = 80 + col * 140;
            let top = 60 + row * 64;
            rects.push((left, top, left + 18, top + 18));
        }
    }
    rects
}

fn print_policy_stats(name: &str, rects: &[BenchRect]) {
    for high_pressure in [false, true] {
        let stats = evaluate_overdraw_policy(rects, high_pressure);
        eprintln!(
            "{name}/{mode}: rawRects={raw} finalRects={final_rects} rawPixels={raw_pixels} sentPixels={sent_pixels} overdrawRatio={ratio:.3}",
            mode = if high_pressure {
                "high_pressure"
            } else {
                "normal"
            },
            raw = stats.raw_rects,
            final_rects = stats.final_rects,
            raw_pixels = stats.raw_pixels,
            sent_pixels = stats.sent_pixels,
            ratio = stats.overdraw_ratio,
        );
    }
}

fn bench_overdraw_policy(c: &mut Criterion) {
    let cases = [
        ("dense_tiles", dense_tile_rects()),
        ("sparse_widgets", sparse_widget_rects()),
        ("drag_browser", drag_browser_rects()),
        ("checkerboard", checkerboard_rects()),
    ];

    for (name, rects) in &cases {
        print_policy_stats(name, rects);
    }

    let mut group = c.benchmark_group("rdp_overdraw_policy");
    for (name, rects) in &cases {
        group.bench_function(format!("{name}_normal"), |b| {
            b.iter(|| evaluate_overdraw_policy(black_box(rects), black_box(false)))
        });
        group.bench_function(format!("{name}_high_pressure"), |b| {
            b.iter(|| evaluate_overdraw_policy(black_box(rects), black_box(true)))
        });
    }
    group.finish();
}

criterion_group!(benches, bench_overdraw_policy);
criterion_main!(benches);
