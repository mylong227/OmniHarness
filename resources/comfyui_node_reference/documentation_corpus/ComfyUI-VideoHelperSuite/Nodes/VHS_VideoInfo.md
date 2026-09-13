---
tags:
  - Multimedia
  - VideoHelperSuite
---

# Video Info 🎥🅥🅗🅢

## Documentation

- Class name: `VHS_VideoInfo`
- Category: `Video Helper Suite 🎥🅥🅗🅢`
- Output node: `False`

The VHS_VideoInfo node is designed to extract and provide detailed information about a video file, focusing on key attributes that define its playback and visual characteristics. This node serves as a foundational element within the Video Helper Suite, enabling users to gain insights into video metadata essential for processing and manipulation tasks.

## Input types

### Required

- **`video_info`**
  - This parameter is essential as it carries the video metadata which the node uses to extract and analyze key video attributes, impacting the node's ability to provide comprehensive video information.
  - Comfy dtype: `VHS_VIDEOINFO`
  - Python dtype: `dict`

## Output types

- **`source_fps🟨`**
  - Comfy dtype: `FLOAT`
  - The frame rate of the source video, indicating how many frames are displayed per second.
  - Python dtype: `float`
- **`source_frame_count🟨`**
  - Comfy dtype: `INT`
  - The total number of frames in the source video.
  - Python dtype: `int`
- **`source_duration🟨`**
  - Comfy dtype: `FLOAT`
  - The total duration of the source video in seconds.
  - Python dtype: `float`
- **`source_width🟨`**
  - Comfy dtype: `INT`
  - The width of the source video in pixels.
  - Python dtype: `int`
- **`source_height🟨`**
  - Comfy dtype: `INT`
  - The height of the source video in pixels.
  - Python dtype: `int`
- **`loaded_fps🟦`**
  - Comfy dtype: `FLOAT`
  - The frame rate of the loaded video, indicating how many frames are displayed per second.
  - Python dtype: `float`
- **`loaded_frame_count🟦`**
  - Comfy dtype: `INT`
  - The total number of frames in the loaded video.
  - Python dtype: `int`
- **`loaded_duration🟦`**
  - Comfy dtype: `FLOAT`
  - The total duration of the loaded video in seconds.
  - Python dtype: `float`
- **`loaded_width🟦`**
  - Comfy dtype: `INT`
  - The width of the loaded video in pixels.
  - Python dtype: `int`
- **`loaded_height🟦`**
  - Comfy dtype: `INT`
  - The height of the loaded video in pixels.
  - Python dtype: `int`

## Usage tips

- Infra type: `CPU`
- Common nodes: unknown

## Source code

```python
class VideoInfo:
    @classmethod
    def INPUT_TYPES(s):
        return {
                "required": {
                    "video_info": ("VHS_VIDEOINFO",),
                    }
                }

    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢"

    RETURN_TYPES = ("FLOAT","INT", "FLOAT", "INT", "INT", "FLOAT","INT", "FLOAT", "INT", "INT")
    RETURN_NAMES = (
        "source_fps🟨",
        "source_frame_count🟨",
        "source_duration🟨",
        "source_width🟨",
        "source_height🟨",
        "loaded_fps🟦",
        "loaded_frame_count🟦",
        "loaded_duration🟦",
        "loaded_width🟦",
        "loaded_height🟦",
    )
    FUNCTION = "get_video_info"

    def get_video_info(self, video_info):
        keys = ["fps", "frame_count", "duration", "width", "height"]

        source_info = []
        loaded_info = []

        for key in keys:
            source_info.append(video_info[f"source_{key}"])
            loaded_info.append(video_info[f"loaded_{key}"])

        return (*source_info, *loaded_info)

```
