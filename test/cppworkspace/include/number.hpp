#pragma once
#include <iostream>
#include <type_traits>

template <typename Number>
concept IsNumber =
    std::is_floating_point_v<Number> || std::is_integral_v<Number>;

template <IsNumber T> constexpr auto number_type_name(const T &t) {
  if constexpr (std::is_same_v<T, double>) {
    return "double";
  } else if constexpr (std::is_same_v<T, float>) {
    return "float";
  } else {
    return "int";
  }
}

/**
 * This is not supposed to be good C++ code,
 * template or otherwise. It's sole purpose is testing
 * how debugging templated C++ types in GDB and how it handles
 * that.
 */
template <IsNumber N> class Number {
  N value;

public:
  explicit constexpr Number(N value) : value(value) {}
  constexpr Number(const Number &) = default;
  constexpr ~Number() = default;

  constexpr static Number<N> sum(Number<N> a, Number<N> b) {
    auto result = Number{a.value + b.value};
    return result;
  }

  constexpr friend auto &operator<<(std::ostream &os, const Number &number) {
    os << number_type_name(number.value) << ": " << number.value;
    return os;
  }

private:
  constexpr bool is_zero() const {
    if constexpr (std::is_floating_point_v<N>) {
      return this->value == 0.0;
    } else {
      return this->value == 0;
    }
  }
};