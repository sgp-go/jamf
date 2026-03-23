#!/usr/bin/env python3
"""将 jamf-api-integration.md 转换为格式美观的 PDF 文档"""

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.lib.units import mm, cm
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, HRFlowable, KeepTogether
)
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import re
import os

# 注册中文字体 - 使用 Arial Unicode（覆盖最全，中英文都支持）
pdfmetrics.registerFont(TTFont('ArialUni', '/Library/Fonts/Arial Unicode.ttf'))
# STHeiti 作为标题字体
pdfmetrics.registerFont(TTFont('STHeiti', '/System/Library/Fonts/STHeiti Medium.ttc', subfontIndex=0))
pdfmetrics.registerFont(TTFont('STHeiti-Light', '/System/Library/Fonts/STHeiti Light.ttc', subfontIndex=0))

# 字体名
FONT = 'STHeiti'          # 标题/粗体
FONT_LIGHT = 'ArialUni'   # 正文（覆盖更全）
FONT_CODE = 'ArialUni'    # 代码块（替代 Courier，确保中文显示）

# 颜色定义
PRIMARY = HexColor("#1a73e8")
DARK = HexColor("#202124")
GRAY = HexColor("#5f6368")
LIGHT_BG = HexColor("#f8f9fa")
CODE_BG = HexColor("#f1f3f4")
BORDER = HexColor("#dadce0")
WHITE = colors.white

def create_styles():
    styles = getSampleStyleSheet()

    styles.add(ParagraphStyle(
        'DocTitle', parent=styles['Title'],
        fontSize=26, leading=32, textColor=PRIMARY,
        spaceAfter=6, alignment=TA_CENTER,
        fontName=FONT
    ))
    styles.add(ParagraphStyle(
        'DocSubtitle', parent=styles['Normal'],
        fontSize=11, leading=16, textColor=GRAY,
        spaceAfter=20, alignment=TA_CENTER,
        fontName=FONT_LIGHT
    ))
    styles.add(ParagraphStyle(
        'H2', parent=styles['Heading2'],
        fontSize=18, leading=24, textColor=PRIMARY,
        spaceBefore=24, spaceAfter=10,
        fontName=FONT,
        borderColor=PRIMARY, borderWidth=0,
        borderPadding=0
    ))
    styles.add(ParagraphStyle(
        'H3', parent=styles['Heading3'],
        fontSize=14, leading=20, textColor=DARK,
        spaceBefore=16, spaceAfter=8,
        fontName=FONT
    ))
    styles.add(ParagraphStyle(
        'H4', parent=styles['Heading4'],
        fontSize=12, leading=16, textColor=GRAY,
        spaceBefore=12, spaceAfter=6,
        fontName=FONT
    ))
    styles.add(ParagraphStyle(
        'BodyText2', parent=styles['Normal'],
        fontSize=10, leading=15, textColor=DARK,
        spaceAfter=6, fontName=FONT_LIGHT
    ))
    styles.add(ParagraphStyle(
        'CodeBlock', parent=styles['Normal'],
        fontSize=8.5, leading=12, textColor=HexColor("#333333"),
        fontName=FONT_CODE, backColor=CODE_BG,
        borderColor=BORDER, borderWidth=0.5,
        borderPadding=8, spaceAfter=10, spaceBefore=4,
        leftIndent=10, rightIndent=10
    ))
    styles.add(ParagraphStyle(
        'BulletItem', parent=styles['Normal'],
        fontSize=10, leading=15, textColor=DARK,
        leftIndent=20, bulletIndent=8, spaceAfter=3,
        fontName=FONT_LIGHT,
        bulletFontName=FONT, bulletFontSize=10
    ))
    styles.add(ParagraphStyle(
        'NumberItem', parent=styles['Normal'],
        fontSize=10, leading=15, textColor=DARK,
        leftIndent=20, bulletIndent=8, spaceAfter=3,
        fontName=FONT_LIGHT
    ))
    styles.add(ParagraphStyle(
        'Note', parent=styles['Normal'],
        fontSize=9, leading=14, textColor=HexColor("#6a4c00"),
        backColor=HexColor("#fef7e0"), borderColor=HexColor("#f9ab00"),
        borderWidth=0.5, borderPadding=8,
        leftIndent=10, rightIndent=10,
        spaceBefore=6, spaceAfter=10,
        fontName=FONT_LIGHT
    ))
    styles.add(ParagraphStyle(
        'TableCell', parent=styles['Normal'],
        fontSize=9, leading=13, textColor=DARK,
        fontName=FONT_LIGHT
    ))
    styles.add(ParagraphStyle(
        'TableHeader', parent=styles['Normal'],
        fontSize=9, leading=13, textColor=WHITE,
        fontName=FONT
    ))
    return styles


def escape_xml(text):
    """转义 XML 特殊字符"""
    text = text.replace("&", "&amp;")
    text = text.replace("<", "&lt;")
    text = text.replace(">", "&gt;")
    return text


def format_inline(text):
    """处理行内格式：**bold**, `code`, 链接等"""
    # 先转义
    text = text.replace("&", "&amp;")
    # 保护 code 标记
    parts = re.split(r'(`[^`]+`)', text)
    result = []
    for part in parts:
        if part.startswith('`') and part.endswith('`'):
            code = part[1:-1].replace("<", "&lt;").replace(">", "&gt;")
            result.append(f'<font face="Courier" size="9" color="#d93025" backColor="#f1f3f4">&nbsp;{code}&nbsp;</font>')
        else:
            part = part.replace("<", "&lt;").replace(">", "&gt;")
            part = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', part)
            part = re.sub(r'https?://[^\s)]+', lambda m: f'<font color="#1a73e8"><u>{m.group()}</u></font>', part)
            result.append(part)
    return ''.join(result)


def parse_table(lines):
    """解析 Markdown 表格"""
    rows = []
    for line in lines:
        line = line.strip().strip('|')
        cells = [c.strip() for c in line.split('|')]
        rows.append(cells)
    # 移除分隔行
    if len(rows) > 1 and all(re.match(r'^[-:]+$', c) for c in rows[1]):
        rows.pop(1)
    return rows


def build_story(md_path, styles):
    story = []

    with open(md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    lines = content.split('\n')
    i = 0
    in_code_block = False
    code_lines = []

    while i < len(lines):
        line = lines[i]

        # 代码块
        if line.strip().startswith('```'):
            if in_code_block:
                code_text = escape_xml('\n'.join(code_lines))
                code_text = code_text.replace('\n', '<br/>')
                code_text = code_text.replace(' ', '&nbsp;')
                story.append(Paragraph(code_text, styles['CodeBlock']))
                code_lines = []
                in_code_block = False
            else:
                in_code_block = True
                code_lines = []
            i += 1
            continue

        if in_code_block:
            code_lines.append(line)
            i += 1
            continue

        # 空行
        if not line.strip():
            i += 1
            continue

        # H1 标题 - 作为文档标题
        if line.startswith('# ') and not line.startswith('## '):
            title = line[2:].strip()
            story.append(Spacer(1, 30))
            story.append(Paragraph(title, styles['DocTitle']))
            story.append(Paragraph("Jamf Pro API Integration Guide", styles['DocSubtitle']))
            story.append(HRFlowable(width="60%", thickness=2, color=PRIMARY, spaceAfter=20))
            i += 1
            continue

        # H2
        if line.startswith('## '):
            text = format_inline(line[3:].strip())
            story.append(Spacer(1, 6))
            story.append(HRFlowable(width="100%", thickness=0.5, color=BORDER, spaceBefore=10, spaceAfter=2))
            story.append(Paragraph(text, styles['H2']))
            i += 1
            continue

        # H3
        if line.startswith('### '):
            text = format_inline(line[4:].strip())
            story.append(Paragraph(text, styles['H3']))
            i += 1
            continue

        # H4
        if line.startswith('#### '):
            text = format_inline(line[5:].strip())
            story.append(Paragraph(text, styles['H4']))
            i += 1
            continue

        # 表格
        if '|' in line and i + 1 < len(lines) and '---' in lines[i + 1]:
            table_lines = []
            while i < len(lines) and '|' in lines[i]:
                table_lines.append(lines[i])
                i += 1
            rows = parse_table(table_lines)
            if rows:
                # 构建表格
                table_data = []
                for ri, row in enumerate(rows):
                    if ri == 0:
                        table_data.append([
                            Paragraph(format_inline(c), styles['TableHeader']) for c in row
                        ])
                    else:
                        table_data.append([
                            Paragraph(format_inline(c), styles['TableCell']) for c in row
                        ])

                col_count = len(rows[0])
                avail_width = A4[0] - 50 * mm
                col_widths = [avail_width / col_count] * col_count

                t = Table(table_data, colWidths=col_widths, repeatRows=1)
                t.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (-1, 0), PRIMARY),
                    ('TEXTCOLOR', (0, 0), (-1, 0), WHITE),
                    ('FONTNAME', (0, 0), (-1, 0), FONT),
                    ('FONTNAME', (0, 1), (-1, -1), FONT_LIGHT),
                    ('FONTSIZE', (0, 0), (-1, -1), 9),
                    ('BACKGROUND', (0, 1), (-1, -1), WHITE),
                    ('ROWBACKGROUNDS', (0, 1), (-1, -1), [WHITE, LIGHT_BG]),
                    ('GRID', (0, 0), (-1, -1), 0.5, BORDER),
                    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                    ('TOPPADDING', (0, 0), (-1, -1), 6),
                    ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
                    ('LEFTPADDING', (0, 0), (-1, -1), 8),
                    ('RIGHTPADDING', (0, 0), (-1, -1), 8),
                ]))
                story.append(t)
                story.append(Spacer(1, 8))
            continue

        # 注意/引用
        if line.startswith('>'):
            note_text = format_inline(line.lstrip('> ').strip())
            # 收集多行引用
            while i + 1 < len(lines) and lines[i + 1].startswith('>'):
                i += 1
                note_text += '<br/>' + format_inline(lines[i].lstrip('> ').strip())
            story.append(Paragraph(note_text, styles['Note']))
            i += 1
            continue

        # 有序列表
        m = re.match(r'^(\d+)\.\s+(.+)', line)
        if m:
            text = format_inline(m.group(2))
            bullet = f"{m.group(1)}."
            story.append(Paragraph(text, styles['NumberItem'], bulletText=bullet))
            # 收集子项
            while i + 1 < len(lines) and re.match(r'^\s+-\s+', lines[i + 1]):
                i += 1
                sub = format_inline(lines[i].strip().lstrip('- '))
                story.append(Paragraph(sub, styles['BulletItem'], bulletText='\u2022'))
            i += 1
            continue

        # 无序列表
        if re.match(r'^-\s+', line):
            text = format_inline(line[2:].strip())
            story.append(Paragraph(text, styles['BulletItem'], bulletText='\u2022'))
            i += 1
            continue

        # 普通段落
        text = format_inline(line.strip())
        story.append(Paragraph(text, styles['BodyText2']))
        i += 1

    return story


def header_footer(canvas, doc):
    """页眉页脚"""
    canvas.saveState()
    width, height = A4

    # 页眉线
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.5)
    canvas.line(25 * mm, height - 18 * mm, width - 25 * mm, height - 18 * mm)

    # 页眉文字
    canvas.setFont(FONT_LIGHT, 8)
    canvas.setFillColor(GRAY)
    canvas.drawString(25 * mm, height - 16 * mm, "Jamf Pro API Integration")
    canvas.drawRightString(width - 25 * mm, height - 16 * mm, "cogrow.jamfcloud.com")

    # 页脚
    canvas.setStrokeColor(BORDER)
    canvas.line(25 * mm, 18 * mm, width - 25 * mm, 18 * mm)
    canvas.setFont(FONT_LIGHT, 8)
    canvas.setFillColor(GRAY)
    canvas.drawCentredString(width / 2, 12 * mm, f"Page {doc.page}")
    canvas.drawRightString(width - 25 * mm, 12 * mm, "Confidential")

    canvas.restoreState()


def main():
    md_path = os.path.join(os.path.dirname(__file__), "jamf-api-integration.md")
    pdf_path = os.path.join(os.path.dirname(__file__), "jamf-api-integration.pdf")

    doc = SimpleDocTemplate(
        pdf_path,
        pagesize=A4,
        topMargin=25 * mm,
        bottomMargin=25 * mm,
        leftMargin=25 * mm,
        rightMargin=25 * mm,
        title="Jamf Pro API Integration",
        author="Jay Hao",
        subject="Jamf Pro API Integration Documentation"
    )

    styles = create_styles()
    story = build_story(md_path, styles)

    doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
    print(f"PDF 已生成: {pdf_path}")


if __name__ == "__main__":
    main()
