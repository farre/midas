#include <iostream>
#include <vector>
#include <string>
#include <number.hpp>
#include "testcase_namespaces/test_ptrs.hpp"
#include "testcase_namespaces/enum.hpp"
#include "testcase_namespaces/baseclasses.hpp"
#include "testcase_namespaces/longstack.hpp"
#include "testcase_namespaces/statics.hpp"
#include "testcase_namespaces/structrequests.hpp"
#include "testcase_namespaces/derive.hpp"

int overload(int a)
{
  return a * 2;
}
float overload(float a)
{
  return a * 2.0f;
}
double overload(double a)
{
  return a * 2.0;
}

template <IsNumber Num>
Number<Num> add_two(Num a, Num b)
{
  Number l{a};
  Number r{b};
  return Number<Num>::sum(l, r);
}

int main(int argc, const char **argv)
{
  const auto somelocal = 42;
  constexpr int array[42] = {};
  auto iptr = new int{42};

  // shadowing test
  int i = 10;
  {
    int i = 20;
    float f = 2.0f;
  }
  const auto j = i;

  i += 1;
  // set breakpoint here.
  auto Double = add_two(1.550795, 1.590795);
  auto Float = add_two(668.19685f, 668.93685f);
  auto Int = add_two(20, 22);

  int ol1 = overload(1);
  float ol2 = overload(2.0f);
  double ol3 = overload(3.0);

  // lets be longer than a machine register
  static const auto foo = "foobar is something to say";
  static constexpr auto bar = "saying barfoo is something nobody does";
  constexpr auto baz = "baz is also kind of a cool word!!!!!!!!!!!!!!!";
  constexpr const char *bazchar = "These types end up being wildly different";
  std::cout << "Goodbye cruel world" << std::endl;

  test_ptrs_main();
  enum_stuff();
  derive::main();
  baseclasses::main();
  longstack::main();
  statics::main();
  structsrequests::main();
}
