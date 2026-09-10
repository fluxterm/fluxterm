use core::cmp::{max, min};

use ironrdp_pdu::geometry::{InclusiveRectangle, Rectangle as _};

// TODO(@pacmancoder): This code currently works only on `InclusiveRectangle`, but it should be
// made generic over `Rectangle` trait

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Region {
    pub extents: InclusiveRectangle,
    pub rectangles: Vec<InclusiveRectangle>,
}

impl Region {
    pub fn new() -> Self {
        Self {
            extents: InclusiveRectangle::empty(),
            rectangles: Vec::new(),
        }
    }

    /// 按闭区间像素合并水平带；内部使用 u32 半开边界以保留单行和最大坐标。
    pub fn union_rectangle(&mut self, rectangle: InclusiveRectangle) {
        if self.rectangles.is_empty() {
            *self = Self::from(rectangle);
            return;
        }

        let top = u32::from(rectangle.top);
        let end = u32::from(rectangle.bottom) + 1;
        let mut pending_top = top;
        let mut dst = Vec::with_capacity(self.rectangles.len() + 1);
        for band in split_bands(&self.rectangles) {
            let band_top = u32::from(band[0].top);
            let band_end = u32::from(band[0].bottom) + 1;
            // 新区域在已有带之前或带间的部分也必须写入，不能被包含关系吞掉。
            if pending_top < min(band_top, end) {
                copy_band(
                    core::slice::from_ref(&rectangle),
                    &mut dst,
                    pending_top as u16,
                    (min(band_top, end) - 1) as u16,
                );
            }
            if band_top < min(top, band_end) {
                copy_band(band, &mut dst, band_top as u16, (min(top, band_end) - 1) as u16);
            }
            let overlap_top = max(top, band_top);
            let overlap_end = min(end, band_end);
            if overlap_top < overlap_end {
                copy_band_with_union(band, &mut dst, overlap_top as u16, (overlap_end - 1) as u16, &rectangle);
            }
            if max(end, band_top) < band_end {
                copy_band(band, &mut dst, max(end, band_top) as u16, (band_end - 1) as u16);
            }
            pending_top = max(pending_top, band_end);
        }
        if pending_top < end {
            copy_band(
                core::slice::from_ref(&rectangle),
                &mut dst,
                pending_top as u16,
                rectangle.bottom,
            );
        }
        self.rectangles = dst;
        self.extents = self.extents.union(&rectangle);
        self.simplify();
    }

    #[must_use]
    pub fn intersect_rectangle(&self, rectangle: &InclusiveRectangle) -> Self {
        match self.rectangles.len() {
            0 => Self::new(),
            1 => self.extents.intersect(rectangle).map(Self::from).unwrap_or_default(),
            _ => {
                let rectangles = self
                    .rectangles
                    .iter()
                    .take_while(|r| r.top <= rectangle.bottom)
                    .filter_map(|r| r.intersect(rectangle))
                    .collect::<Vec<_>>();
                let extents = InclusiveRectangle::union_all(rectangles.as_slice());

                let mut region = Self { rectangles, extents };
                region.simplify();

                region
            }
        }
    }

    fn simplify(&mut self) {
        /* Simplify consecutive bands that touch and have the same items
         *
         *  ====================          ====================
         *     | 1 |  | 2   |               |   |  |     |
         *  ====================            |   |  |     |
         *     | 1 |  | 2   |	   ====>    | 1 |  |  2  |
         *  ====================            |   |  |     |
         *     | 1 |  | 2   |               |   |  |     |
         *  ====================          ====================
         *
         */

        if self.rectangles.len() < 2 {
            return;
        }

        let mut current_band_start = 0;
        while current_band_start < self.rectangles.len()
            && current_band_start + get_current_band(&self.rectangles[current_band_start..]).len()
                < self.rectangles.len()
        {
            let current_band = get_current_band(&self.rectangles[current_band_start..]);
            let next_band = get_current_band(&self.rectangles[current_band_start + current_band.len()..]);

            if u32::from(current_band[0].bottom) + 1 >= u32::from(next_band[0].top)
                && bands_internals_equal(current_band, next_band)
            {
                let first_band_len = current_band.len();
                let second_band_len = next_band.len();
                let second_band_bottom = next_band[0].bottom;
                self.rectangles
                    .drain(current_band_start + first_band_len..current_band_start + first_band_len + second_band_len);
                self.rectangles
                    .iter_mut()
                    .skip(current_band_start)
                    .take(first_band_len)
                    .for_each(|r| r.bottom = second_band_bottom);
            } else {
                current_band_start += current_band.len();
            }
        }
    }
}

impl Default for Region {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod coverage_regression {
    use super::*;

    /// 矩形并集必须保留输入覆盖的每个像素，包括交叠和单行区域。
    #[test]
    fn union_preserves_all_input_pixels() {
        let mut random = 7u32;
        for _ in 0..2000 {
            let mut region = Region::new();
            let mut expected = [false; 256];
            for _ in 0..8 {
                let mut coords = [0u16; 4];
                for value in &mut coords {
                    random = random.wrapping_mul(1664525).wrapping_add(1013904223);
                    *value = ((random >> 16) % 16) as u16;
                }
                let rect = InclusiveRectangle {
                    left: coords[0].min(coords[2]),
                    top: coords[1].min(coords[3]),
                    right: coords[0].max(coords[2]),
                    bottom: coords[1].max(coords[3]),
                };
                for y in rect.top..=rect.bottom {
                    for x in rect.left..=rect.right {
                        expected[usize::from(y * 16 + x)] = true;
                    }
                }
                region.union_rectangle(rect);
                for y in 0..16u16 {
                    for x in 0..16u16 {
                        let count = region
                            .rectangles
                            .iter()
                            .filter(|r| r.left <= x && x <= r.right && r.top <= y && y <= r.bottom)
                            .count();
                        assert_eq!(
                            count,
                            usize::from(expected[usize::from(y * 16 + x)]),
                            "pixel ({x},{y}), {region:?}"
                        );
                    }
                }
            }
        }
    }

    /// 单行、单列与最大坐标在并集及瓦片裁剪后均保留，边界计算不溢出。
    #[test]
    fn thin_regions_at_max_coordinate_survive_tile_clipping() {
        let row = InclusiveRectangle {
            left: 65532,
            top: 65535,
            right: 65535,
            bottom: 65535,
        };
        let column = InclusiveRectangle {
            left: 65535,
            top: 65532,
            right: 65535,
            bottom: 65535,
        };
        let mut region = Region::from(row.clone());
        region.union_rectangle(column.clone());
        region.union_rectangle(row.clone());
        assert_eq!(region.intersect_rectangle(&row), Region::from(row));
        assert_eq!(region.intersect_rectangle(&column), Region::from(column));
        let absent = InclusiveRectangle {
            left: 65532,
            top: 65532,
            right: 65534,
            bottom: 65534,
        };
        assert!(region.intersect_rectangle(&absent).rectangles.is_empty());
    }
}

impl From<InclusiveRectangle> for Region {
    fn from(r: InclusiveRectangle) -> Self {
        Self {
            extents: r.clone(),
            rectangles: vec![r],
        }
    }
}

/// 将一个水平区间加入已排序的带，合并相交区间而不跨越空隙。
fn copy_band_with_union(
    band: &[InclusiveRectangle],
    dst: &mut Vec<InclusiveRectangle>,
    band_top: u16,
    band_bottom: u16,
    union_rectangle: &InclusiveRectangle,
) {
    let mut merged = InclusiveRectangle {
        top: band_top,
        bottom: band_bottom,
        left: union_rectangle.left,
        right: union_rectangle.right,
    };
    for (index, item) in band.iter().enumerate() {
        if item.right < merged.left {
            copy_band(core::slice::from_ref(item), dst, band_top, band_bottom);
        } else if merged.right < item.left {
            dst.push(merged);
            copy_band(&band[index..], dst, band_top, band_bottom);
            return;
        } else {
            merged.left = min(merged.left, item.left);
            merged.right = max(merged.right, item.right);
        }
    }
    dst.push(merged);
}

fn copy_band(band: &[InclusiveRectangle], dst: &mut Vec<InclusiveRectangle>, band_top: u16, band_bottom: u16) {
    dst.extend(band.iter().map(|r| InclusiveRectangle {
        top: band_top,
        bottom: band_bottom,
        left: r.left,
        right: r.right,
    }));
}

fn split_bands(mut rectangles: &[InclusiveRectangle]) -> Vec<&[InclusiveRectangle]> {
    let mut bands = Vec::new();
    while !rectangles.is_empty() {
        let band = get_current_band(rectangles);
        rectangles = &rectangles[band.len()..];
        bands.push(band);
    }

    bands
}

fn get_current_band(rectangles: &[InclusiveRectangle]) -> &[InclusiveRectangle] {
    let band_top = rectangles[0].top;

    for i in 1..rectangles.len() {
        if rectangles[i].top != band_top {
            return &rectangles[..i];
        }
    }

    rectangles
}

fn bands_internals_equal(first_band: &[InclusiveRectangle], second_band: &[InclusiveRectangle]) -> bool {
    if first_band.len() != second_band.len() {
        return false;
    }

    for (first_band_rect, second_band_rect) in first_band.iter().zip(second_band.iter()) {
        if first_band_rect.left != second_band_rect.left || first_band_rect.right != second_band_rect.right {
            return false;
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use std::sync::LazyLock;

    use super::*;

    static REGION_FOR_RECTANGLES_INTERSECTION: LazyLock<Region> = LazyLock::new(|| Region {
        extents: InclusiveRectangle {
            left: 1,
            top: 1,
            right: 11,
            bottom: 9,
        },
        rectangles: vec![
            InclusiveRectangle {
                left: 1,
                top: 1,
                right: 5,
                bottom: 3,
            },
            InclusiveRectangle {
                left: 7,
                top: 1,
                right: 8,
                bottom: 3,
            },
            InclusiveRectangle {
                left: 9,
                top: 1,
                right: 11,
                bottom: 3,
            },
            InclusiveRectangle {
                left: 7,
                top: 3,
                right: 11,
                bottom: 4,
            },
            InclusiveRectangle {
                left: 3,
                top: 4,
                right: 6,
                bottom: 6,
            },
            InclusiveRectangle {
                left: 7,
                top: 4,
                right: 11,
                bottom: 6,
            },
            InclusiveRectangle {
                left: 1,
                top: 6,
                right: 3,
                bottom: 8,
            },
            InclusiveRectangle {
                left: 4,
                top: 6,
                right: 5,
                bottom: 8,
            },
            InclusiveRectangle {
                left: 6,
                top: 6,
                right: 10,
                bottom: 8,
            },
            InclusiveRectangle {
                left: 4,
                top: 8,
                right: 5,
                bottom: 9,
            },
            InclusiveRectangle {
                left: 6,
                top: 8,
                right: 10,
                bottom: 9,
            },
        ],
    });

    #[test]
    fn union_rectangle_sets_extents_and_single_rectangle_for_empty_region() {
        let mut region = Region::new();

        let input_rectangle = InclusiveRectangle {
            left: 5,
            top: 1,
            right: 9,
            bottom: 2,
        };

        let expected_region = Region {
            extents: input_rectangle.clone(),
            rectangles: vec![input_rectangle.clone()],
        };

        region.union_rectangle(input_rectangle);
        assert_eq!(expected_region, region);
    }

    #[test]
    fn union_rectangle_places_new_rectangle_higher_relative_to_band() {
        let existing_band_rectangle = InclusiveRectangle {
            left: 2,
            top: 3,
            right: 7,
            bottom: 7,
        };
        let mut region = Region {
            extents: existing_band_rectangle.clone(),
            rectangles: vec![existing_band_rectangle.clone()],
        };

        let input_rectangle = InclusiveRectangle {
            left: 5,
            top: 1,
            right: 9,
            bottom: 2,
        };

        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 2,
                top: 1,
                right: 9,
                bottom: 7,
            },
            rectangles: vec![input_rectangle.clone(), existing_band_rectangle],
        };

        region.union_rectangle(input_rectangle);
        assert_eq!(expected_region, region);
    }

    #[test]
    fn union_rectangle_places_new_rectangle_lower_relative_to_band() {
        let existing_band_rectangle = InclusiveRectangle {
            left: 2,
            top: 3,
            right: 7,
            bottom: 7,
        };
        let mut region = Region {
            extents: existing_band_rectangle.clone(),
            rectangles: vec![existing_band_rectangle.clone()],
        };

        let input_rectangle = InclusiveRectangle {
            left: 1,
            top: 8,
            right: 4,
            bottom: 10,
        };

        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 1,
                top: 3,
                right: 7,
                bottom: 10,
            },
            rectangles: vec![existing_band_rectangle, input_rectangle.clone()],
        };

        region.union_rectangle(input_rectangle);
        assert_eq!(expected_region, region);
    }

    #[test]
    fn union_rectangle_does_not_add_new_rectangle_which_is_inside_a_band() {
        let existing_band_rectangle = InclusiveRectangle {
            left: 2,
            top: 3,
            right: 7,
            bottom: 7,
        };
        let mut region = Region {
            extents: existing_band_rectangle.clone(),
            rectangles: vec![existing_band_rectangle.clone()],
        };

        let input_rectangle = InclusiveRectangle {
            left: 5,
            top: 4,
            right: 6,
            bottom: 5,
        };

        let expected_region = Region {
            extents: existing_band_rectangle.clone(),
            rectangles: vec![existing_band_rectangle],
        };

        region.union_rectangle(input_rectangle);
        assert_eq!(expected_region, region);
    }

    #[test]
    fn union_rectangle_cuts_new_rectangle_top_part_which_crosses_band_on_top() {
        let existing_band_rectangle = InclusiveRectangle {
            left: 2,
            top: 3,
            right: 7,
            bottom: 7,
        };
        let mut region = Region {
            extents: existing_band_rectangle.clone(),
            rectangles: vec![existing_band_rectangle],
        };

        let input_rectangle = InclusiveRectangle {
            left: 1,
            top: 2,
            right: 4,
            bottom: 4,
        };

        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 1,
                top: 2,
                right: 7,
                bottom: 7,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 1,
                    top: 2,
                    right: 4,
                    bottom: 2,
                },
                InclusiveRectangle {
                    left: 1,
                    top: 3,
                    right: 7,
                    bottom: 4,
                },
                InclusiveRectangle {
                    left: 2,
                    top: 5,
                    right: 7,
                    bottom: 7,
                },
            ],
        };

        region.union_rectangle(input_rectangle);
        assert_eq!(expected_region, region);
    }

    #[test]
    fn union_rectangle_cuts_new_rectangle_lower_part_which_crosses_band_on_bottom() {
        let existing_band_rectangle = InclusiveRectangle {
            left: 2,
            top: 3,
            right: 7,
            bottom: 7,
        };
        let mut region = Region {
            extents: existing_band_rectangle.clone(),
            rectangles: vec![existing_band_rectangle],
        };

        let input_rectangle = InclusiveRectangle {
            left: 5,
            top: 6,
            right: 9,
            bottom: 8,
        };

        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 2,
                top: 3,
                right: 9,
                bottom: 8,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 2,
                    top: 3,
                    right: 7,
                    bottom: 5,
                },
                InclusiveRectangle {
                    left: 2,
                    top: 6,
                    right: 9,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 5,
                    top: 8,
                    right: 9,
                    bottom: 8,
                },
            ],
        };

        region.union_rectangle(input_rectangle);
        assert_eq!(expected_region, region);
    }

    #[test]
    fn union_rectangle_cuts_new_rectangle_higher_and_lower_part_which_crosses_band_on_top_and_bottom() {
        let existing_band_rectangle = InclusiveRectangle {
            left: 2,
            top: 3,
            right: 7,
            bottom: 7,
        };
        let mut region = Region {
            extents: existing_band_rectangle.clone(),
            rectangles: vec![existing_band_rectangle],
        };

        let input_rectangle = InclusiveRectangle {
            left: 3,
            top: 1,
            right: 5,
            bottom: 11,
        };

        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 2,
                top: 1,
                right: 7,
                bottom: 11,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 3,
                    top: 1,
                    right: 5,
                    bottom: 2,
                },
                InclusiveRectangle {
                    left: 2,
                    top: 3,
                    right: 7,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 3,
                    top: 8,
                    right: 5,
                    bottom: 11,
                },
            ],
        };

        region.union_rectangle(input_rectangle);
        assert_eq!(expected_region, region);
    }

    #[test]
    fn union_rectangle_inserts_new_rectangle_in_band_of_3_rectangles_without_merging_with_rectangles() {
        let mut region = Region {
            extents: InclusiveRectangle {
                left: 2,
                top: 3,
                right: 15,
                bottom: 7,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 2,
                    top: 3,
                    right: 7,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 8,
                    top: 3,
                    right: 9,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 12,
                    top: 3,
                    right: 15,
                    bottom: 7,
                },
            ],
        };

        let input_rectangle = InclusiveRectangle {
            left: 10,
            top: 3,
            right: 11,
            bottom: 7,
        };
        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 2,
                top: 3,
                right: 15,
                bottom: 7,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 2,
                    top: 3,
                    right: 7,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 8,
                    top: 3,
                    right: 9,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 10,
                    top: 3,
                    right: 11,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 12,
                    top: 3,
                    right: 15,
                    bottom: 7,
                },
            ],
        };

        region.union_rectangle(input_rectangle);
        assert_eq!(expected_region, region);
    }

    #[test]
    fn union_rectangle_inserts_new_rectangle_in_band_of_3_rectangles_with_merging_with_side_rectangles() {
        let mut region = Region {
            extents: InclusiveRectangle {
                left: 2,
                top: 3,
                right: 15,
                bottom: 7,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 2,
                    top: 3,
                    right: 7,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 8,
                    top: 3,
                    right: 10,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 13,
                    top: 3,
                    right: 15,
                    bottom: 7,
                },
            ],
        };

        let input_rectangle = InclusiveRectangle {
            left: 9,
            top: 3,
            right: 14,
            bottom: 7,
        };
        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 2,
                top: 3,
                right: 15,
                bottom: 7,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 2,
                    top: 3,
                    right: 7,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 8,
                    top: 3,
                    right: 15,
                    bottom: 7,
                },
            ],
        };

        region.union_rectangle(input_rectangle);
        assert_eq!(expected_region, region);
    }

    #[test]
    fn union_rectangle_inserts_new_rectangle_in_band_of_3_rectangles_with_merging_with_side_rectangles_on_board() {
        let mut region = Region {
            extents: InclusiveRectangle {
                left: 2,
                top: 3,
                right: 15,
                bottom: 7,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 2,
                    top: 3,
                    right: 7,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 8,
                    top: 3,
                    right: 10,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 13,
                    top: 3,
                    right: 15,
                    bottom: 7,
                },
            ],
        };

        let input_rectangle = InclusiveRectangle {
            left: 10,
            top: 3,
            right: 13,
            bottom: 7,
        };
        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 2,
                top: 3,
                right: 15,
                bottom: 7,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 2,
                    top: 3,
                    right: 7,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 8,
                    top: 3,
                    right: 15,
                    bottom: 7,
                },
            ],
        };

        region.union_rectangle(input_rectangle);
        assert_eq!(expected_region, region);
    }

    #[test]
    fn union_rectangle_inserts_new_rectangle_between_two_bands() {
        let mut region = Region {
            extents: InclusiveRectangle {
                left: 1,
                top: 3,
                right: 7,
                bottom: 10,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 2,
                    top: 3,
                    right: 7,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 1,
                    top: 8,
                    right: 4,
                    bottom: 10,
                },
            ],
        };

        let input_rectangle = InclusiveRectangle {
            left: 3,
            top: 4,
            right: 4,
            bottom: 9,
        };
        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 1,
                top: 3,
                right: 7,
                bottom: 10,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 2,
                    top: 3,
                    right: 7,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 1,
                    top: 8,
                    right: 4,
                    bottom: 10,
                },
            ],
        };

        region.union_rectangle(input_rectangle);
        assert_eq!(expected_region, region);
    }

    #[test]
    fn simplify_does_not_change_two_different_bands_with_multiple_rectangles() {
        let mut region = Region {
            extents: InclusiveRectangle {
                left: 1,
                top: 1,
                right: 7,
                bottom: 3,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 1,
                    top: 1,
                    right: 2,
                    bottom: 2,
                },
                InclusiveRectangle {
                    left: 3,
                    top: 1,
                    right: 4,
                    bottom: 2,
                },
                InclusiveRectangle {
                    left: 5,
                    top: 1,
                    right: 6,
                    bottom: 2,
                },
                InclusiveRectangle {
                    left: 1,
                    top: 2,
                    right: 2,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 3,
                    top: 2,
                    right: 4,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 5,
                    top: 2,
                    right: 7,
                    bottom: 3,
                },
            ],
        };
        let expected_region = region.clone();

        region.simplify();
        assert_eq!(expected_region, region);
    }

    #[test]
    fn simplify_does_not_change_two_different_bands_with_one_rectangle() {
        let mut region = Region {
            extents: InclusiveRectangle {
                left: 2,
                top: 1,
                right: 7,
                bottom: 11,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 3,
                    top: 1,
                    right: 5,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 2,
                    top: 3,
                    right: 7,
                    bottom: 7,
                },
            ],
        };
        let expected_region = region.clone();

        region.simplify();
        assert_eq!(expected_region, region);
    }

    #[test]
    fn simplify_does_not_change_three_different_bands_with_one_rectangle() {
        let mut region = Region {
            extents: InclusiveRectangle {
                left: 2,
                top: 1,
                right: 7,
                bottom: 11,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 3,
                    top: 1,
                    right: 5,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 2,
                    top: 3,
                    right: 7,
                    bottom: 7,
                },
                InclusiveRectangle {
                    left: 3,
                    top: 7,
                    right: 5,
                    bottom: 11,
                },
            ],
        };
        let expected_region = region.clone();

        region.simplify();
        assert_eq!(expected_region, region);
    }

    #[test]
    fn simplify_merges_bands_with_identical_internal_rectangles() {
        let mut region = Region {
            extents: InclusiveRectangle {
                left: 1,
                top: 1,
                right: 7,
                bottom: 3,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 1,
                    top: 1,
                    right: 2,
                    bottom: 2,
                },
                InclusiveRectangle {
                    left: 3,
                    top: 1,
                    right: 4,
                    bottom: 2,
                },
                InclusiveRectangle {
                    left: 5,
                    top: 1,
                    right: 6,
                    bottom: 2,
                },
                InclusiveRectangle {
                    left: 1,
                    top: 2,
                    right: 2,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 3,
                    top: 2,
                    right: 4,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 5,
                    top: 2,
                    right: 6,
                    bottom: 3,
                },
            ],
        };
        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 1,
                top: 1,
                right: 7,
                bottom: 3,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 1,
                    top: 1,
                    right: 2,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 3,
                    top: 1,
                    right: 4,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 5,
                    top: 1,
                    right: 6,
                    bottom: 3,
                },
            ],
        };

        region.simplify();
        assert_eq!(expected_region, region);
    }

    #[test]
    fn simplify_merges_three_bands_with_identical_internal_rectangles() {
        let mut region = Region {
            extents: InclusiveRectangle {
                left: 1,
                top: 1,
                right: 7,
                bottom: 3,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 1,
                    top: 1,
                    right: 2,
                    bottom: 2,
                },
                InclusiveRectangle {
                    left: 3,
                    top: 1,
                    right: 4,
                    bottom: 2,
                },
                InclusiveRectangle {
                    left: 5,
                    top: 1,
                    right: 6,
                    bottom: 2,
                },
                InclusiveRectangle {
                    left: 1,
                    top: 2,
                    right: 2,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 3,
                    top: 2,
                    right: 4,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 5,
                    top: 2,
                    right: 6,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 1,
                    top: 3,
                    right: 2,
                    bottom: 4,
                },
                InclusiveRectangle {
                    left: 3,
                    top: 3,
                    right: 4,
                    bottom: 4,
                },
                InclusiveRectangle {
                    left: 5,
                    top: 3,
                    right: 6,
                    bottom: 4,
                },
            ],
        };
        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 1,
                top: 1,
                right: 7,
                bottom: 3,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 1,
                    top: 1,
                    right: 2,
                    bottom: 4,
                },
                InclusiveRectangle {
                    left: 3,
                    top: 1,
                    right: 4,
                    bottom: 4,
                },
                InclusiveRectangle {
                    left: 5,
                    top: 1,
                    right: 6,
                    bottom: 4,
                },
            ],
        };

        region.simplify();
        assert_eq!(expected_region, region);
    }

    #[test]
    fn simplify_merges_two_pairs_of_bands_with_identical_internal_rectangles() {
        let mut region = Region {
            extents: InclusiveRectangle {
                left: 1,
                top: 1,
                right: 7,
                bottom: 5,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 1,
                    top: 1,
                    right: 2,
                    bottom: 2,
                },
                InclusiveRectangle {
                    left: 3,
                    top: 1,
                    right: 4,
                    bottom: 2,
                },
                InclusiveRectangle {
                    left: 5,
                    top: 1,
                    right: 6,
                    bottom: 2,
                },
                InclusiveRectangle {
                    left: 1,
                    top: 2,
                    right: 2,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 3,
                    top: 2,
                    right: 4,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 5,
                    top: 2,
                    right: 6,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 2,
                    top: 3,
                    right: 3,
                    bottom: 4,
                },
                InclusiveRectangle {
                    left: 4,
                    top: 3,
                    right: 5,
                    bottom: 4,
                },
                InclusiveRectangle {
                    left: 6,
                    top: 3,
                    right: 7,
                    bottom: 4,
                },
                InclusiveRectangle {
                    left: 2,
                    top: 4,
                    right: 3,
                    bottom: 5,
                },
                InclusiveRectangle {
                    left: 4,
                    top: 4,
                    right: 5,
                    bottom: 5,
                },
                InclusiveRectangle {
                    left: 6,
                    top: 4,
                    right: 7,
                    bottom: 5,
                },
            ],
        };
        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 1,
                top: 1,
                right: 7,
                bottom: 5,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 1,
                    top: 1,
                    right: 2,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 3,
                    top: 1,
                    right: 4,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 5,
                    top: 1,
                    right: 6,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 2,
                    top: 3,
                    right: 3,
                    bottom: 5,
                },
                InclusiveRectangle {
                    left: 4,
                    top: 3,
                    right: 5,
                    bottom: 5,
                },
                InclusiveRectangle {
                    left: 6,
                    top: 3,
                    right: 7,
                    bottom: 5,
                },
            ],
        };

        region.simplify();
        assert_eq!(expected_region, region);
    }

    #[test]
    fn intersect_rectangle_returns_empty_region_for_not_intersecting_rectangle() {
        let region = &*REGION_FOR_RECTANGLES_INTERSECTION;
        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
            rectangles: Vec::new(),
        };
        let input_rectangle = InclusiveRectangle {
            left: 1,
            top: 4,
            right: 2,
            bottom: 5,
        };

        let actual_region = region.intersect_rectangle(&input_rectangle);
        assert_eq!(expected_region, actual_region);
    }

    #[test]
    fn intersect_rectangle_returns_empty_region_for_empty_intersection_region() {
        let expected_region: Region = Region {
            extents: InclusiveRectangle {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
            rectangles: Vec::new(),
        };
        let input_rectangle = InclusiveRectangle {
            left: 5,
            top: 2,
            right: 6,
            bottom: 3,
        };

        let actual_region = expected_region.intersect_rectangle(&input_rectangle);
        assert_eq!(expected_region, actual_region);
    }

    #[test]
    fn intersect_rectangle_returns_part_of_rectangle_that_overlaps_for_region_with_one_rectangle() {
        let region = Region {
            extents: InclusiveRectangle {
                left: 1,
                top: 1,
                right: 5,
                bottom: 3,
            },
            rectangles: vec![InclusiveRectangle {
                left: 1,
                top: 1,
                right: 5,
                bottom: 3,
            }],
        };
        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 2,
                top: 2,
                right: 3,
                bottom: 3,
            },
            rectangles: vec![InclusiveRectangle {
                left: 2,
                top: 2,
                right: 3,
                bottom: 3,
            }],
        };
        let input_rectangle = InclusiveRectangle {
            left: 2,
            top: 2,
            right: 3,
            bottom: 3,
        };

        let actual_region = region.intersect_rectangle(&input_rectangle);
        assert_eq!(expected_region, actual_region);
    }

    #[test]
    fn intersect_rectangle_returns_region_with_parts_of_rectangles_that_intersect_input_rectangle() {
        let region = &*REGION_FOR_RECTANGLES_INTERSECTION;
        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 3,
                top: 2,
                right: 8,
                bottom: 5,
            },
            rectangles: vec![
                InclusiveRectangle {
                    left: 3,
                    top: 2,
                    right: 5,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 7,
                    top: 2,
                    right: 8,
                    bottom: 3,
                },
                InclusiveRectangle {
                    left: 7,
                    top: 3,
                    right: 8,
                    bottom: 4,
                },
                InclusiveRectangle {
                    left: 3,
                    top: 4,
                    right: 6,
                    bottom: 5,
                },
                InclusiveRectangle {
                    left: 7,
                    top: 4,
                    right: 8,
                    bottom: 5,
                },
            ],
        };
        let input_rectangle = InclusiveRectangle {
            left: 3,
            top: 2,
            right: 8,
            bottom: 5,
        };

        let actual_region = region.intersect_rectangle(&input_rectangle);
        assert_eq!(expected_region, actual_region);
    }

    #[test]
    fn intersect_rectangle_returns_region_with_exact_sizes_of_rectangle_that_overlaps_it() {
        let region = &*REGION_FOR_RECTANGLES_INTERSECTION;
        let expected_region = Region {
            extents: InclusiveRectangle {
                left: 2,
                top: 2,
                right: 4,
                bottom: 3,
            },
            rectangles: vec![InclusiveRectangle {
                left: 2,
                top: 2,
                right: 4,
                bottom: 3,
            }],
        };
        let input_rectangle: InclusiveRectangle = InclusiveRectangle {
            left: 2,
            top: 2,
            right: 4,
            bottom: 3,
        };

        let actual_region = region.intersect_rectangle(&input_rectangle);
        assert_eq!(expected_region, actual_region);
    }
}
