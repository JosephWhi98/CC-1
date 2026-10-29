import Cocoa
// Renders a 1024px TE-style app icon: warm grey squircle, dark LCD with the pixel crab, orange key row.
let S: CGFloat = 1024
let img = NSImage(size: NSSize(width: S, height: S))
img.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext
func C(_ r: Int, _ g: Int, _ b: Int, _ a: CGFloat = 1) -> NSColor { NSColor(red: CGFloat(r)/255, green: CGFloat(g)/255, blue: CGFloat(b)/255, alpha: a) }
let inset: CGFloat = 100
let body = NSRect(x: inset, y: inset, width: S - 2*inset, height: S - 2*inset)
let path = NSBezierPath(roundedRect: body, xRadius: 185, yRadius: 185)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -18), blur: 40, color: NSColor.black.withAlphaComponent(0.35).cgColor)
C(233, 231, 225).setFill(); path.fill()
ctx.restoreGState()
ctx.saveGState(); path.addClip()
NSGradient(colors: [NSColor.white.withAlphaComponent(0.55), NSColor.clear, NSColor.black.withAlphaComponent(0.08)])!.draw(in: body, angle: -90)
ctx.restoreGState()
NSColor.black.withAlphaComponent(0.12).setStroke(); path.lineWidth = 3; path.stroke()

// LCD bezel + glowing glass
let bez = NSRect(x: body.minX + 54, y: body.minY + 54, width: body.width - 108, height: body.height - 108)
let bezP = NSBezierPath(roundedRect: bez, xRadius: 70, yRadius: 70)
let lcd = bez.insetBy(dx: 26, dy: 26)
let lcdP = NSBezierPath(roundedRect: lcd, xRadius: 48, yRadius: 48)
// light spilling from the screen onto the case
ctx.saveGState(); path.addClip()
NSGradient(colors: [C(255, 120, 40, 0.38), C(255, 120, 40, 0)], atLocations: [0, 1], colorSpace: .sRGB)!
    .draw(fromCenter: CGPoint(x: lcd.midX, y: lcd.midY), radius: 120, toCenter: CGPoint(x: lcd.midX, y: lcd.midY), radius: 520, options: [])
ctx.restoreGState()
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -8), blur: 14, color: NSColor.white.withAlphaComponent(0.8).cgColor)
C(44, 46, 40).setFill(); bezP.fill()
ctx.restoreGState()
// glass
ctx.saveGState(); lcdP.addClip()
NSGradient(colors: [C(46, 66, 36), C(21, 32, 17), C(8, 13, 7)], atLocations: [0, 0.6, 1], colorSpace: .sRGB)!
    .draw(fromCenter: CGPoint(x: lcd.midX, y: lcd.midY + 20), radius: 0, toCenter: CGPoint(x: lcd.midX, y: lcd.midY + 20), radius: 470, options: [.drawsAfterEndingLocation])
// pixel grid + scanlines
C(120, 255, 90, 0.045).setFill()
var gx = lcd.minX; while gx < lcd.maxX { NSBezierPath(rect: NSRect(x: gx, y: lcd.minY, width: 1.5, height: lcd.height)).fill(); gx += 12 }
var gy = lcd.minY; while gy < lcd.maxY { NSBezierPath(rect: NSRect(x: lcd.minX, y: gy, width: lcd.width, height: 1.5)).fill(); gy += 12 }
NSColor.black.withAlphaComponent(0.22).setFill()
gy = lcd.minY; while gy < lcd.maxY { NSBezierPath(rect: NSRect(x: lcd.minX, y: gy, width: lcd.width, height: 3)).fill(); gy += 6 }

// pixel crab (same sprite as the in-app display)
let p: CGFloat = 19, cw = 26 * p, ch = 15 * p
let ox = lcd.midX - cw / 2, top = lcd.midY + ch / 2 + 4
func px(_ x: Int, _ y: Int, _ w: Int, _ h: Int, _ c: NSColor) {
    c.setFill(); NSBezierPath(rect: NSRect(x: ox + CGFloat(x) * p, y: top - CGFloat(y + h) * p, width: CGFloat(w) * p, height: CGFloat(h) * p)).fill()
}
func crab(_ orange: NSColor, _ hi: NSColor, _ lo: NSColor, _ eye: NSColor) {
    px(3, 0, 20, 11, orange); px(0, 4, 3, 4, orange); px(23, 4, 3, 4, orange)
    for o in [1, 6, 13, 18] { px(3 + o, 11, 3, 4, orange) }
    px(3, 0, 20, 1, hi); px(3, 10, 20, 1, lo)
    for o in [1, 6, 13, 18] { px(3 + o, 14, 3, 1, lo) }
    px(7, 3, 2, 3, eye); px(17, 3, 2, 3, eye)
    px(11, 8, 4, 1, eye); px(10, 7, 1, 1, eye); px(15, 7, 1, 1, eye)
}
// bloom: wide soft halo, then tight halo, then the crisp sprite
for (blur, a) in [(150.0, 0.9), (60.0, 0.9)] {
    ctx.saveGState()
    ctx.setShadow(offset: .zero, blur: CGFloat(blur), color: C(255, 90, 10, CGFloat(a)).cgColor)
    crab(C(255, 77, 0), C(255, 77, 0), C(255, 77, 0), C(255, 77, 0))
    ctx.restoreGState()
}
crab(C(255, 84, 8), C(255, 170, 110), C(205, 50, 0), C(14, 20, 10))
// sparkles
let spk = C(150, 255, 110, 0.9)
ctx.saveGState(); ctx.setShadow(offset: .zero, blur: 24, color: C(120, 255, 90, 0.9).cgColor)
for (sx, sy) in [(-3, -3), (27, -2), (28, 14), (-2, 15)] { px(sx, sy, 1, 1, spk); px(sx - 1, sy + 1, 3, 1, spk); px(sx, sy + 2, 1, 1, spk) }
ctx.restoreGState()
// vignette + glass reflection
NSGradient(colors: [C(0, 0, 0, 0), C(0, 0, 0, 0), C(0, 0, 0, 0.5)], atLocations: [0, 0.6, 1], colorSpace: .sRGB)!
    .draw(fromCenter: CGPoint(x: lcd.midX, y: lcd.midY), radius: 0, toCenter: CGPoint(x: lcd.midX, y: lcd.midY), radius: 520, options: [.drawsAfterEndingLocation])
let gl = NSBezierPath(); gl.move(to: CGPoint(x: lcd.minX, y: lcd.maxY)); gl.line(to: CGPoint(x: lcd.minX + 420, y: lcd.maxY)); gl.line(to: CGPoint(x: lcd.minX, y: lcd.maxY - 300)); gl.close()
NSGradient(colors: [NSColor.white.withAlphaComponent(0.09), NSColor.white.withAlphaComponent(0)])!.draw(in: gl, angle: -45)
ctx.restoreGState()
C(0, 0, 0, 0.55).setStroke(); lcdP.lineWidth = 4; lcdP.stroke()
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
