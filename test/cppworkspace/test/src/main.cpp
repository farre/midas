#include <iostream>
#include <iterator>
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
#include "testcase_namespaces/pp.hpp"

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

struct S {
  int j;
  int k;
};

struct T {
  S s;
  float f;
};

void doFooBar() {
  S fooBar{.j = 10, .k = 100};
  fooBar.j += 1;
}

void testRValueReferences(std::string&& item) {
  auto result = item;
  std::cout << "item is: " << result;
}

int main(int argc, const char **argv)
{
  std::vector<std::string> captured_args;
  std::copy(argv, argv+argc, std::back_inserter(captured_args));
  std::string helloworld{"Hello world, I manage myself and I'm also made sure to be allocated on the heap"};
  std::string_view v{helloworld};

  doFooBar();
  testRValueReferences(std::move(helloworld));
  T t{.s = S{.j = 10, .k = 200}, .f = 3.14};
  const auto somelocal = 42;
  constexpr int array[42] = {};
  auto iptr = new int{42};
  t.s.j++;

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
  prettyprinting::main();
  test_ptrs_main();
  enum_stuff();
  derive::main();
  baseclasses::main();
  longstack::main();
  statics::main();
  structsrequests::main();
}
