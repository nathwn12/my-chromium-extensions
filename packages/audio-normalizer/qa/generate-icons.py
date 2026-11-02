from PIL import Image, ImageDraw
import os

sizes = [16, 32, 48, 128]
out_dir = os.path.join(os.path.dirname(__file__), '..', 'audio')

def hex_to_rgba(h, a=255):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4)) + (a,)

bg = hex_to_rgba('#0a0a0a')
accent = hex_to_rgba('#00e5ff')

def draw_icon(size):
    img = Image.new('RGBA', (size, size), bg)
    d = ImageDraw.Draw(img)

    # Angled frame
    pad = max(1, int(size * 0.06))
    bw = max(1, int(size * 0.023))
    frame = [
        (pad, 0),
        (size - pad, 0),
        (size, pad),
        (size, size - pad),
        (size - pad, size),
        (pad, size),
        (0, size - pad),
        (0, pad),
    ]
    d.polygon(frame, outline=accent)
    # Thicken the frame outline by drawing again with slight offset if needed
    if bw > 1:
        # PIL's polygon outline is 1px, so draw multiple times for thickness
        for i in range(bw):
            inset = [(x + (1 if x > size//2 else -1) * i, y + (1 if y > size//2 else -1) * i) for x, y in frame]
            d.polygon(inset, outline=accent)

    # Three equalizer bars with rounded tops
    bar_w = max(1, int(size * 0.11))
    gap = max(1, int(size * 0.075))
    start_x = (size - (3 * bar_w + 2 * gap)) // 2

    bar_heights = [0.31, 0.47, 0.37]
    bar_bottoms = [0.75, 0.75, 0.75]

    for i, (bh, bb) in enumerate(zip(bar_heights, bar_bottoms)):
        x = start_x + i * (bar_w + gap)
        h = max(2, int(size * bh))
        bottom = int(size * bb)
        top = bottom - h
        # Draw rounded rectangle manually
        d.rectangle([x, top + bar_w//2, x + bar_w, bottom], fill=accent)
        d.ellipse([x, top, x + bar_w, top + bar_w], fill=accent)

    return img

for s in sizes:
    img = draw_icon(s)
    path = os.path.join(out_dir, f'icon-{s}.png')
    img.save(path)
    print(f'Generated icon-{s}.png')
