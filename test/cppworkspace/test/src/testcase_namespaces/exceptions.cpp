#include "exceptions.hpp"
#include <iostream>
#include <stdexcept>

namespace exceptions {
void main(int i) {
  try {
    if (i < 10) {
      throw std::runtime_error{"i is below 10"};
    }
  } catch (std::exception &e) {
    std::cout << "exception caught: " << e.what() << std::endl;
  }

  // un caught exception
  if (i < 5) {
    throw std::runtime_error{"i below 5"};
  }
}
} // namespace exceptions