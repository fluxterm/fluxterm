use std::hint::black_box;

use criterion::{Criterion, criterion_group, criterion_main};
use fluxterm_rdp_core::benchmark_support::merge_update_rects;

type BenchRect = (u16, u16, u16, u16);

/// 构造大量互不相邻的矩形，覆盖无法合并时的扫描成本。
fn sparse_separated_rects(count: u16) -> Vec<BenchRect> {
    (0..count)
        .map(|index| {
            let x = (u32::from(index) * 190) % 1200;
            let y = ((u32::from(index) * 190) / 1200) * 190;
            let left = x as u16;
            let top = y.min(700) as u16;
            (left, top, left + 9, top + 9)
        })
        .collect()
}

/// 构造链式矩形，覆盖“外接框扩张后继续吞并”的旧语义热路径。
fn chain_merge_rects(count: u16) -> Vec<BenchRect> {
    (0..count)
        .map(|index| {
            let left = index * 24;
            (left, 120, left + 12, 132)
        })
        .collect()
}

/// 构造接近拖动浏览器窗口时的纵向条带和碎片更新。
fn drag_browser_like_rects() -> Vec<BenchRect> {
    let mut rects = Vec::with_capacity(96);
    for row in 0..12_u16 {
        let y = 60 + row * 42;
        rects.push((48, y, 1320, y + 9));
        rects.push((48, y + 14, 68, y + 38));
        rects.push((1298, y + 14, 1320, y + 38));
        rects.push((120 + row * 7, y + 18, 420 + row * 7, y + 30));
    }
    rects
}

fn bench_rect_merge(c: &mut Criterion) {
    let sparse = sparse_separated_rects(64);
    let chain = chain_merge_rects(64);
    let drag_browser = drag_browser_like_rects();

    let mut group = c.benchmark_group("rdp_rect_merge");
    group.bench_function("sparse_separated_64", |b| {
        b.iter(|| merge_update_rects(black_box(&sparse)))
    });
    group.bench_function("chain_merge_64", |b| {
        b.iter(|| merge_update_rects(black_box(&chain)))
    });
    group.bench_function("drag_browser_like", |b| {
        b.iter(|| merge_update_rects(black_box(&drag_browser)))
    });
    group.finish();
}

criterion_group!(benches, bench_rect_merge);
criterion_main!(benches);
