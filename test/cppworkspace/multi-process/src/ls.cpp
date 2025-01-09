#include <iostream>
#include <filesystem>

namespace fs = std::filesystem;

int main() {
    std::cout << "Listing directory contents:" << std::endl;

    try {
        for (const auto& entry : fs::directory_iterator(".")) {
            std::cout << entry.path().filename().string() << std::endl;
        }
    } catch (const fs::filesystem_error& e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return 1;
    }

    return 0;
}