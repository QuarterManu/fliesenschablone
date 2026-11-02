import sys


def export_cli(img, out):
    """Ohne Oberfläche: Fliesenschablone.exe --export zeichnung.jpg ausgabe.stl"""
    from app.project import Project
    p = Project()
    p.load_image(img)
    p.detect()
    p.suggest_struts()
    p.export_stl(out)


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--export":
        try:
            export_cli(sys.argv[2], sys.argv[3])
        except Exception:
            import traceback
            traceback.print_exc()
            sys.exit(1)
        sys.exit(0)
    from app.gui import main
    main()
