# -*- coding: utf-8 -*-
"""
Electron icon generator
1. Remove white background
2. Generate formats for all platforms
"""

from PIL import Image
import os

def remove_white_background(img, threshold=245):
    img = img.convert("RGBA")
    pixels = img.load()
    width, height = img.size
    
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            # Check if pixel is near-white (all RGB channels >= threshold)
            if r >= threshold and g >= threshold and b >= threshold:
                pixels[x, y] = (r, g, b, 0)  # Make transparent
    
    return img

def remove_white_background_old(img, threshold=250):
    img = img.convert("RGBA")
    data = list(img.getdata())
    
    new_data = []
    for item in data:
        if item[0] > threshold and item[1] > threshold and item[2] > threshold:
            new_data.append((255, 255, 255, 0))
        else:
            new_data.append(item)
    
    img.putdata(new_data)
    return img

def trim_and_pad(img, padding_percent=5, target_size=1024):
    """Trim transparent borders, add padding, and resize to target size"""
    # Get bounding box of non-transparent content
    bbox = img.getbbox()
    if bbox:
        cropped = img.crop(bbox)
        
        # Make it square (use larger dimension)
        w, h = cropped.size
        size = max(w, h)
        
        # Add padding
        padding = int(size * padding_percent / 100)
        padded_size = size + padding * 2
        
        # Create square image with padding
        result = Image.new("RGBA", (padded_size, padded_size), (0, 0, 0, 0))
        offset_x = (padded_size - w) // 2
        offset_y = (padded_size - h) // 2
        result.paste(cropped, (offset_x, offset_y))
        
        # Resize to target size (1024x1024)
        if padded_size != target_size:
            result = result.resize((target_size, target_size), Image.Resampling.LANCZOS)
        
        return result
    return img

def generate_icons(source_path, output_dir, padding_percent=5):
    print("Loading source image: " + source_path)
    original = Image.open(source_path)
    
    print("Removing white background...")
    transparent = remove_white_background(original)
    
    print("Trimming borders (padding: " + str(padding_percent) + "%)...")
    transparent = trim_and_pad(transparent, padding_percent)
    
    # Save transparent PNG (1024x1024)
    icon_png_path = os.path.join(output_dir, "icon.png")
    transparent.save(icon_png_path, "PNG")
    print("[OK] icon.png (1024x1024)")
    
    # Windows .ico (multiple sizes)
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_images = []
    for size in ico_sizes:
        resized = transparent.resize((size, size), Image.Resampling.LANCZOS)
        ico_images.append(resized)
    
    ico_path = os.path.join(output_dir, "icon.ico")
    ico_images[-1].save(
        ico_path, 
        format="ICO", 
        sizes=[(s, s) for s in ico_sizes]
    )
    print("[OK] icon.ico (sizes: " + str(ico_sizes) + ")")
    
    # macOS .icns
    icns_path = os.path.join(output_dir, "icon.icns")
    transparent.save(icns_path, format="ICNS")
    print("[OK] icon.icns")
    
    # Linux PNG sizes
    linux_sizes = [16, 24, 32, 48, 64, 128, 256, 512]
    icons_dir = os.path.join(output_dir, "icons")
    os.makedirs(icons_dir, exist_ok=True)
    
    for size in linux_sizes:
        resized = transparent.resize((size, size), Image.Resampling.LANCZOS)
        size_path = os.path.join(icons_dir, str(size) + "x" + str(size) + ".png")
        resized.save(size_path, "PNG")
        print("[OK] icons/" + str(size) + "x" + str(size) + ".png")
    
    # Tray icons
    tray_sizes = [16, 24, 32]
    tray_dir = os.path.join(output_dir, "tray")
    os.makedirs(tray_dir, exist_ok=True)
    
    for size in tray_sizes:
        resized = transparent.resize((size, size), Image.Resampling.LANCZOS)
        tray_path = os.path.join(tray_dir, "tray-" + str(size) + ".png")
        resized.save(tray_path, "PNG")
        tray_template_path = os.path.join(tray_dir, "tray-" + str(size) + "Template.png")
        resized.save(tray_template_path, "PNG")
    
    print("[OK] tray/ (tray icons)")
    print("\nAll icons generated!")
    print("Output: " + output_dir)

if __name__ == "__main__":
    script_dir = os.path.dirname(os.path.abspath(__file__))
    source = os.path.join(script_dir, "icon_bk.png")
    generate_icons(source, script_dir)
