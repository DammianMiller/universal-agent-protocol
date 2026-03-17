# P34: Image-to-Structured Pipeline

**Category**: Domain-Specific
**Abbreviation**: Image-Structured

## Pattern

For image analysis (OCR, diagram interpretation), use proper image processing libraries. Do not "interpret" images.

## Rule

```
Image analysis → Use OCR/vision library → Return structured output.
```

## Implementation

1. Load image with proper library
2. Apply OCR or analysis
3. Return structured data
4. Verify output is usable

## Image Processing Tools

```python
# OCR
import pytesseract
from PIL import Image

text = pytesseract.image_to_string(Image.open('image.png'))

# Computer Vision
import cv2
image = cv2.imread('image.png')

# Charts/Diagrams
# Use specialized tools for chart extraction
```

## Structured Output Examples

- Chess board → FEN notation
- Table image → CSV/JSON
- Diagram → Component list
- Form → Field mappings

## Anti-Pattern

❌ "Looking at" image and guessing content
❌ Describing image instead of extracting data
❌ Not using proper OCR/vision tools
