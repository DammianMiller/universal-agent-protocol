# P23: Compression Impossibility Detection

**Category**: Verification
**Abbreviation**: Compress-Check

## Pattern

Before compressing, check if further compression is possible. Some formats are already maximally compressed.

## Rule

```
Already compressed formats → Cannot compress further meaningfully.
```

## Implementation

1. Check file format
2. If already compressed: explain limitation
3. Suggest alternative approaches if needed

## Already Compressed Formats

- .zip, .gz, .bz2, .xz
- .png, .jpg, .webp (images)
- .mp4, .mp3, .webm (media)
- .pdf (usually)

## Compressible Formats

- .txt, .log, .csv
- .json, .xml
- .bmp, .tiff
- .avi, .wav

## Response Format

```
This file is already compressed ([format]).
Further compression will not meaningfully reduce size.

Alternatives:
- [suggest alternatives if applicable]
```

## Anti-Pattern

❌ Compressing already-compressed files
❌ Claiming compression savings when minimal
❌ Not checking format before attempting compression
