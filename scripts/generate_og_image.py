from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

width, height = 1200, 630
base = Image.new('RGBA', (width, height), (7, 7, 11, 255))

# Create glowing ambient lights
glow_layer = Image.new('RGBA', (width, height), (0, 0, 0, 0))
glow_draw = ImageDraw.Draw(glow_layer)

def draw_radial_glow(draw_ctx, cx, cy, radius, color, max_alpha):
    for r in range(radius, 0, -8):
        alpha = int(max_alpha * (1.0 - (r / radius) ** 1.8))
        draw_ctx.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(color[0], color[1], color[2], alpha))

# Red aura top-left
draw_radial_glow(glow_draw, 200, 100, 420, (229, 9, 20), 80)
# Cosmic purple aura on the right
draw_radial_glow(glow_draw, 960, 260, 480, (120, 40, 202), 70)
# Golden warm bloom bottom-left
draw_radial_glow(glow_draw, 280, 520, 320, (245, 166, 35), 45)
# Cyan accent top-right
draw_radial_glow(glow_draw, 1100, 80, 260, (0, 160, 255), 40)

base = Image.alpha_composite(base, glow_layer)
draw = ImageDraw.Draw(base)

# Load fonts
font_dir = 'C:/Windows/Fonts/'
def get_font(name, size):
    try:
        return ImageFont.truetype(os.path.join(font_dir, name), size)
    except:
        return ImageFont.load_default()

font_brand = get_font('ariblk.ttf', 44)
font_title = get_font('bahnschrift.ttf', 52)
font_title_bold = get_font('ariblk.ttf', 50)
font_subtitle = get_font('bahnschrift.ttf', 22)
font_badge = get_font('arialbd.ttf', 16)
font_btn = get_font('arialbd.ttf', 20)
font_small = get_font('bahnschrift.ttf', 16)
font_tag = get_font('arialbd.ttf', 13)

# Draw Logo Icon (Cine-N badge)
icon_x, icon_y, icon_s = 75, 65, 54
draw.rounded_rectangle([icon_x, icon_y, icon_x + icon_s, icon_y + icon_s], radius=16, fill=(18, 18, 28), outline=(229, 9, 20), width=2)
draw.rectangle([icon_x + 14, icon_y + 13, icon_x + 21, icon_y + 41], fill=(229, 9, 20))
draw.polygon([(icon_x + 20, icon_y + 13), (icon_x + 35, icon_y + 41), (icon_x + 40, icon_y + 41), (icon_x + 25, icon_y + 13)], fill=(255, 42, 84))
draw.rectangle([icon_x + 33, icon_y + 13, icon_x + 40, icon_y + 41], fill=(229, 9, 20))
draw.ellipse([icon_x + 41, icon_y + 10, icon_x + 48, icon_y + 17], fill=(245, 166, 35))

# Brand Title
draw.text((icon_x + icon_s + 18, icon_y + 4), 'NovaFlix', font=font_brand, fill=(255, 255, 255))
bbox = font_brand.getbbox('NovaFlix')
nf_w = bbox[2] - bbox[0]
draw.text((icon_x + icon_s + 18 + nf_w + 2, icon_y + 4), 'Zone', font=font_brand, fill=(255, 42, 84))

# 4K Badge next to brand
draw.rounded_rectangle([icon_x + icon_s + 24 + nf_w + 140, icon_y + 14, icon_x + icon_s + 24 + nf_w + 225, icon_y + 42], radius=14, fill=(229, 9, 20, 60), outline=(229, 9, 20), width=1)
draw.text((icon_x + icon_s + 24 + nf_w + 154, icon_y + 19), '4K UHD', font=font_tag, fill=(255, 120, 140))

# Upper Tagline Pill
pill_y = icon_y + icon_s + 38
draw.rounded_rectangle([75, pill_y, 470, pill_y + 32], radius=16, fill=(255, 42, 84, 35), outline=(255, 42, 84, 120), width=1)
draw.ellipse([88, pill_y + 11, 98, pill_y + 21], fill=(255, 42, 84))
draw.text((106, pill_y + 7), 'ULTRA-PREMIUM STREAMING & DOWNLOADS', font=font_tag, fill=(255, 200, 210))

# Main Headline
head_y = pill_y + 48
draw.text((75, head_y), 'Watch & Download', font=font_title_bold, fill=(255, 255, 255))
draw.text((75, head_y + 60), 'Movies, Series & Anime', font=font_title, fill=(245, 166, 35))

# Sub-headline
sub_y = head_y + 130
draw.text((75, sub_y), 'Zero Buffering  •  Multi-Source 4K UHD  •  Dolby Atmos Sound', font=font_subtitle, fill=(200, 205, 220))
draw.text((75, sub_y + 34), 'Stream online or download directly to your PC & mobile device free.', font=font_subtitle, fill=(150, 155, 175))

# Feature badges
badges = ['⚡ Fast CDN Streaming', '📥 Direct Device Download', '🌐 Multi Subtitles', '🚫 100% Free']
bx = 75
by = sub_y + 85
for b in badges:
    bb = font_badge.getbbox(b)
    bw = bb[2] - bb[0] + 24
    draw.rounded_rectangle([bx, by, bx + bw, by + 34], radius=10, fill=(25, 25, 38), outline=(60, 60, 85), width=1)
    draw.text((bx + 12, by + 7), b, font=font_badge, fill=(230, 235, 245))
    bx += bw + 12

# Play CTA Button
btn_y = by + 60
draw.rounded_rectangle([75, btn_y, 310, btn_y + 54], radius=27, fill=(255, 255, 255))
draw.polygon([(108, btn_y + 18), (108, btn_y + 36), (125, btn_y + 27)], fill=(0, 0, 0))
draw.text((138, btn_y + 15), 'Start Watching Now', font=font_btn, fill=(0, 0, 0))

# Domain watermark on bottom
draw.text((75, height - 38), 'https://novaflixzone.vercel.app', font=font_small, fill=(120, 125, 145))
draw.text((width - 450, height - 38), 'The Ultimate Free Entertainment Zone', font=font_small, fill=(100, 105, 125))

# ================= RIGHT CARDS / POSTER SHOWCASE =================
# Card 1 (Back left)
c1_x, c1_y, c1_w, c1_h = 710, 90, 210, 300
card1 = Image.new('RGBA', (c1_w, c1_h), (20, 20, 35, 240))
c1_draw = ImageDraw.Draw(card1)
for i in range(c1_h):
    c1_draw.line([(2, i), (c1_w - 3, i)], fill=(int(20 + i*0.2), int(10 + i*0.1), int(45 + i*0.3), 255))
c1_draw.rounded_rectangle([0, 0, c1_w - 1, c1_h - 1], radius=18, outline=(120, 40, 202, 180), width=2)
c1_draw.rounded_rectangle([15, 15, 105, 38], radius=8, fill=(120, 40, 202, 180))
c1_draw.text((24, 20), 'TOP SERIES', font=font_tag, fill=(255, 255, 255))
c1_draw.text((18, c1_h - 55), 'Stranger Worlds', font=get_font('arialbd.ttf', 17), fill=(255, 255, 255))
c1_draw.text((18, c1_h - 32), '★ 8.9  •  Season 4  •  4K', font=font_tag, fill=(245, 166, 35))

# Card 2 (Back right)
c2_x, c2_y, c2_w, c2_h = 935, 130, 210, 300
card2 = Image.new('RGBA', (c2_w, c2_h), (20, 20, 35, 240))
c2_draw = ImageDraw.Draw(card2)
for i in range(c2_h):
    c2_draw.line([(2, i), (c2_w - 3, i)], fill=(int(10 + i*0.1), int(25 + i*0.2), int(40 + i*0.3), 255))
c2_draw.rounded_rectangle([0, 0, c2_w - 1, c2_h - 1], radius=18, outline=(0, 160, 255, 180), width=2)
c2_draw.rounded_rectangle([15, 15, 95, 38], radius=8, fill=(0, 160, 255, 180))
c2_draw.text((24, 20), 'ANIME 4K', font=font_tag, fill=(255, 255, 255))
c2_draw.text((18, c2_h - 55), 'Solo Leveling', font=get_font('arialbd.ttf', 18), fill=(255, 255, 255))
c2_draw.text((18, c2_h - 32), '★ 9.1  •  Ultra HD', font=font_tag, fill=(245, 166, 35))

# Card 3 (Hero center card, dominant)
c3_x, c3_y, c3_w, c3_h = 800, 180, 260, 370
card3 = Image.new('RGBA', (c3_w, c3_h), (0, 0, 0, 0))
c3_draw = ImageDraw.Draw(card3)

for i in range(c3_h):
    ratio = i / c3_h
    r = int(35 + (229 - 35) * (ratio ** 2.2))
    g = int(12 + (9 - 12) * ratio)
    b = int(22 + (20 - 22) * ratio)
    c3_draw.line([(5, i), (c3_w - 6, i)], fill=(r, g, b, 255))

for i in range(160):
    alpha = int(255 * (i / 160))
    y = c3_h - 160 + i
    c3_draw.line([(5, y), (c3_w - 6, y)], fill=(7, 7, 11, alpha))

c3_draw.rounded_rectangle([4, 4, c3_w - 5, c3_h - 5], radius=22, outline=(255, 42, 84), width=3)

# Card 3 Badges & Content
c3_draw.rounded_rectangle([18, 18, 175, 46], radius=14, fill=(255, 42, 84, 230))
c3_draw.text((28, 24), '🔥 BLOCKBUSTER', font=font_tag, fill=(255, 255, 255))

c3_draw.rounded_rectangle([185, 18, 235, 46], radius=14, fill=(0, 0, 0, 150), outline=(255, 255, 255, 100), width=1)
c3_draw.text((194, 25), '4K', font=font_tag, fill=(245, 166, 35))

# Movie Title
c3_draw.text((18, c3_h - 110), 'Oppenheimer', font=get_font('ariblk.ttf', 24), fill=(255, 255, 255))
c3_draw.text((18, c3_h - 78), 'IMAX 4K UHD  •  HDR10+', font=font_tag, fill=(200, 205, 220))

# Ratings and play icon
c3_draw.rounded_rectangle([18, c3_h - 50, 115, c3_h - 22], radius=14, fill=(245, 166, 35, 40), outline=(245, 166, 35, 180), width=1)
c3_draw.text((28, c3_h - 45), '★ 9.3 IMDb', font=font_tag, fill=(245, 166, 35))

# Play icon circle
c3_draw.ellipse([c3_w - 55, c3_h - 55, c3_w - 18, c3_h - 18], fill=(255, 42, 84))
c3_draw.polygon([(c3_w - 41, c3_h - 44), (c3_w - 41, c3_h - 28), (c3_w - 28, c3_h - 36)], fill=(255, 255, 255))

# Composite cards with shadow
base.paste(card1, (c1_x, c1_y), card1)
base.paste(card2, (c2_x, c2_y), card2)
base.paste(card3, (c3_x, c3_y), card3)

# Save images
out_rgb = base.convert('RGB')
os.makedirs('web/public', exist_ok=True)
out_rgb.save('web/public/og-image.jpg', 'JPEG', quality=95, optimize=True)
base.save('web/public/og-image.png', 'PNG', optimize=True)
print('Successfully generated og-image.jpg and og-image.png in web/public/')
