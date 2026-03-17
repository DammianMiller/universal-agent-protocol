# Read version from package.json to stay in sync with npm releases
import json, os

try:
    pkg_path = os.path.join(os.path.dirname(__file__), "..", "..", "package.json")
    if not os.path.exists(pkg_path):
        # Try parent directory (for development)
        pkg_path = os.path.join(
            os.path.dirname(__file__), "..", "..", "..", "package.json"
        )

    with open(pkg_path, "r") as f:
        package_data = json.load(f)
        version = package_data.get("version", "1.2.0")
except Exception as e:
    # Fallback for when package.json not available
    version = "3.1.2"

__author__ = "Dammian Miller"


def get_version():
    return version


def get_author():
    return __author__


# Allow direct import of these values for backward compatibility
if __name__ == "__main__":
    print(f"UAP Version: {version}")
